/**
 * Manual vouchers in the shop's books (billing v2, docs/billing §6.1):
 *
 *   JOURNAL        any balanced entry between the shop's ledgers (Tally's
 *                  Journal), e.g. depreciation, a TDS / TCS credit claimed;
 *   CONTRA         cash deposited into or drawn from the bank;
 *   STOCK_JOURNAL  stock moved between the online count and the in-shop count
 *                  (GoKesari's two stock locations) — no money changes hands.
 *
 * Each is one voucher (books.ts postVoucher, which refuses an unbalanced one)
 * and can be reversed, never edited.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { BOOK_ACCOUNTS } from "@/lib/accounts/constants";
import { notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { accLedgerEntries, shopProducts } from "@/server/db/schema";
import { logChange, postVoucher, reverseSource, todayIst } from "./books";
import { postStock } from "./stock";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const journalSchema = z.object({
  date: isoDate.optional(),
  narration: z.string().trim().min(3).max(300),
  legs: z
    .array(
      z.object({
        account: z.enum(BOOK_ACCOUNTS),
        partyId: z.string().uuid().nullable().optional(),
        subAccount: z.string().trim().max(80).nullable().optional(),
        debitPaise: z.number().int().min(0).optional(),
        creditPaise: z.number().int().min(0).optional(),
      }),
    )
    .min(2)
    .max(30),
});

export async function recordJournal(shopId: string, raw: z.infer<typeof journalSchema>, actor: { id: string }): Promise<{ voucherId: string; sourceId: string }> {
  const input = journalSchema.parse(raw);
  const date = input.date ?? todayIst();
  if (date > todayIst()) throw validationFailed("The date is in the future.");
  const dr = input.legs.reduce((n, l) => n + (l.debitPaise ?? 0), 0);
  const cr = input.legs.reduce((n, l) => n + (l.creditPaise ?? 0), 0);
  if (dr === 0 || dr !== cr) throw validationFailed(`Debits (₹${(dr / 100).toFixed(2)}) and credits (₹${(cr / 100).toFixed(2)}) must be equal and above zero.`);
  if (input.legs.some((l) => l.account === "PARTY" && !l.partyId)) throw validationFailed("A party line needs the party.");
  const sourceId = randomUUID();
  return db.transaction(async (tx) => {
    const voucherId = await postVoucher({ shopId, voucherType: "JOURNAL", entryDate: date, sourceType: "JOURNAL", sourceId, docRef: "Journal", narration: input.narration, createdBy: actor.id, legs: input.legs }, tx);
    await logChange({ shopId, entityType: "journal", entityId: sourceId, action: "ISSUE", snapshot: { narration: input.narration, amountPaise: dr }, actorId: actor.id }, tx);
    return { voucherId, sourceId };
  });
}

export const contraSchema = z.object({
  date: isoDate.optional(),
  from: z.enum(["CASH", "BANK"]),
  amountPaise: z.number().int().positive(),
  narration: z.string().trim().max(300).optional(),
});

export async function recordContra(shopId: string, raw: z.infer<typeof contraSchema>, actor: { id: string }): Promise<{ voucherId: string; sourceId: string }> {
  const input = contraSchema.parse(raw);
  const date = input.date ?? todayIst();
  if (date > todayIst()) throw validationFailed("The date is in the future.");
  const to = input.from === "CASH" ? "BANK" : "CASH";
  const sourceId = randomUUID();
  return db.transaction(async (tx) => {
    const voucherId = await postVoucher(
      {
        shopId,
        voucherType: "CONTRA",
        entryDate: date,
        sourceType: "JOURNAL",
        sourceId,
        docRef: "Contra",
        narration: input.narration || (input.from === "CASH" ? "Cash deposited in the bank" : "Cash drawn from the bank"),
        createdBy: actor.id,
        legs: [
          { account: to, debitPaise: input.amountPaise },
          { account: input.from, creditPaise: input.amountPaise },
        ],
      },
      tx,
    );
    return { voucherId, sourceId };
  });
}

/** Reverses a journal or contra (the original stays, with its reversal). */
export async function reverseJournal(shopId: string, sourceId: string, reason: string, actor: { id: string }): Promise<number> {
  if (!reason.trim()) throw validationFailed("Say why it is reversed.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: accLedgerEntries.id }).from(accLedgerEntries).where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.sourceType, "JOURNAL"), eq(accLedgerEntries.sourceId, sourceId))).limit(1);
    if (!row) throw notFound("Voucher");
    const ids = await reverseSource(shopId, "JOURNAL", sourceId, todayIst(), actor.id, `Reversed: ${reason.trim()}`, tx);
    return ids.length;
  });
}

export const stockJournalSchema = z.object({
  date: isoDate.optional(),
  shopProductId: z.string().uuid(),
  from: z.enum(["ONLINE", "OFFLINE"]),
  qtyMilli: z.number().int().positive(),
  note: z.string().trim().max(300).optional(),
});

/** Moves stock between the listing's online and in-shop counts (a stock transfer between the two locations). */
export async function recordStockJournal(shopId: string, raw: z.infer<typeof stockJournalSchema>, actor: { id: string }): Promise<{ sourceId: string }> {
  const input = stockJournalSchema.parse(raw);
  const date = input.date ?? todayIst();
  const to = input.from === "ONLINE" ? "OFFLINE" : "ONLINE";
  const sourceId = randomUUID();
  return db.transaction(async (tx) => {
    const [sp] = await tx.select({ id: shopProducts.id, online: shopProducts.onlineStock, offline: shopProducts.offlineStock }).from(shopProducts).where(and(eq(shopProducts.id, input.shopProductId), eq(shopProducts.shopId, shopId)));
    if (!sp) throw notFound("Product");
    const available = (input.from === "ONLINE" ? sp.online : sp.offline) * 1000;
    if (available < input.qtyMilli) throw validationFailed(`Only ${available / 1000} in the ${input.from === "ONLINE" ? "online" : "in-shop"} count.`);
    const note = input.note || `Stock journal: ${input.from === "ONLINE" ? "online → in-shop" : "in-shop → online"}`;
    await postStock(
      [
        { shopId, shopProductId: sp.id, channel: input.from, movementType: "TRANSFER", qtyMilli: -input.qtyMilli, sourceType: "MANUAL", sourceId, docRef: "Stock journal", entryDate: date, note, createdBy: actor.id },
        { shopId, shopProductId: sp.id, channel: to, movementType: "TRANSFER", qtyMilli: input.qtyMilli, sourceType: "MANUAL", sourceId, docRef: "Stock journal", entryDate: date, note, createdBy: actor.id },
      ],
      tx,
    );
    // The voucher itself (no ledger legs: nothing changes in money).
    await postVoucher({ shopId, voucherType: "STOCK_JOURNAL", entryDate: date, sourceType: "JOURNAL", sourceId, docRef: "Stock journal", narration: note, createdBy: actor.id, legs: [] }, tx);
    await logChange({ shopId, entityType: "stock_journal", entityId: sourceId, action: "ISSUE", snapshot: { shopProductId: sp.id, from: input.from, qtyMilli: input.qtyMilli }, actorId: actor.id }, tx);
    return { sourceId };
  });
}

