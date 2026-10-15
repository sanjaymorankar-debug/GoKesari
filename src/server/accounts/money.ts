/**
 * Payments, receipts, expenses and the cash / bank book and day book
 * (docs/inventory-accounting-2026-10, Part 2).
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { EXPENSE_CATEGORIES, type BookAccount } from "@/lib/accounts/constants";
import { db } from "@/server/db";
import { accExpenses, accLedgerEntries, accParties, accPayments, accPurchaseInvoices, accSalesInvoices, type AccLedgerEntry } from "@/server/db/schema";
import { logChange, postVoucher, reverseSource, todayIst } from "./books";
import { getParty } from "./parties";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const paymentSchema = z.object({
  partyId: z.string().uuid(),
  direction: z.enum(["PAID", "RECEIVED"]),
  mode: z.enum(["CASH", "BANK", "UPI", "CARD"]),
  amountPaise: z.number().int().positive(),
  paymentDate: isoDate.optional(),
  purchaseInvoiceId: z.string().uuid().nullable().optional(),
  salesInvoiceId: z.string().uuid().nullable().optional(),
  reference: z.string().trim().max(80).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
export type PaymentInput = z.infer<typeof paymentSchema>;

const cashAccount = (mode: string): BookAccount => (mode === "CASH" ? "CASH" : "BANK");

export async function recordPayment(shopId: string, raw: PaymentInput, actorId: string) {
  const input = paymentSchema.parse(raw);
  const date = input.paymentDate ?? todayIst();
  if (date > todayIst()) throw validationFailed("The payment date is in the future.");
  const party = await getParty(shopId, input.partyId);
  if (input.purchaseInvoiceId) {
    const [bill] = await db.select({ id: accPurchaseInvoices.id }).from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.id, input.purchaseInvoiceId), eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.partyId, party.id)));
    if (!bill) throw validationFailed("That bill is not from this supplier.");
  }
  if (input.salesInvoiceId) {
    const [inv] = await db.select({ id: accSalesInvoices.id }).from(accSalesInvoices).where(and(eq(accSalesInvoices.id, input.salesInvoiceId), eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.partyId, party.id)));
    if (!inv) throw validationFailed("That invoice is not to this customer.");
  }
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .insert(accPayments)
      .values({ shopId, partyId: party.id, direction: input.direction, mode: input.mode, amountPaise: input.amountPaise, paymentDate: date, purchaseInvoiceId: input.purchaseInvoiceId ?? null, salesInvoiceId: input.salesInvoiceId ?? null, reference: input.reference ?? null, note: input.note ?? null, createdBy: actorId })
      .returning();
    const money = cashAccount(input.mode);
    await postVoucher(
      {
        shopId,
        voucherType: input.direction === "PAID" ? "PAYMENT" : "RECEIPT",
        entryDate: date,
        sourceType: "PAYMENT",
        sourceId: payment.id,
        docRef: input.reference ?? null,
        narration: `${input.direction === "PAID" ? "Paid to" : "Received from"} ${party.name} (${input.mode})`,
        createdBy: actorId,
        legs:
          input.direction === "PAID"
            ? [
                { account: "PARTY", partyId: party.id, debitPaise: input.amountPaise },
                { account: money, creditPaise: input.amountPaise },
              ]
            : [
                { account: money, debitPaise: input.amountPaise },
                { account: "PARTY", partyId: party.id, creditPaise: input.amountPaise },
              ],
      },
      tx,
    );
    await logChange({ shopId, entityType: "payment", entityId: payment.id, action: "CREATE", snapshot: payment as unknown as Record<string, unknown>, actorId }, tx);
    return payment;
  });
}

export async function cancelPayment(shopId: string, paymentId: string, reason: string, actorId: string): Promise<void> {
  if (!reason.trim()) throw validationFailed("Say why the payment is cancelled.");
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(accPayments).where(and(eq(accPayments.id, paymentId), eq(accPayments.shopId, shopId))).for("update");
    if (!p) throw notFound("Payment");
    if (p.status === "CANCELLED") throw conflict("Already cancelled.");
    await reverseSource(shopId, "PAYMENT", paymentId, todayIst(), actorId, `Payment cancelled: ${reason}`, tx);
    await tx.update(accPayments).set({ status: "CANCELLED" }).where(eq(accPayments.id, paymentId));
    await logChange({ shopId, entityType: "payment", entityId: paymentId, action: "CANCEL", changes: [{ field: "status", old: "ACTIVE", new: "CANCELLED" }], reason, actorId }, tx);
  });
}

export async function listPayments(shopId: string, options: { partyId?: string; limit?: number } = {}) {
  return db
    .select({ p: accPayments, partyName: accParties.name })
    .from(accPayments)
    .innerJoin(accParties, eq(accPayments.partyId, accParties.id))
    .where(and(eq(accPayments.shopId, shopId), options.partyId ? eq(accPayments.partyId, options.partyId) : undefined))
    .orderBy(desc(accPayments.paymentDate), desc(accPayments.createdAt))
    .limit(options.limit ?? 300);
}

/* --------------------------------------------------------------- expenses */

export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().trim().max(200).nullable().optional(),
  expenseDate: isoDate.optional(),
  mode: z.enum(["CASH", "BANK", "UPI", "CARD", "CREDIT"]),
  partyId: z.string().uuid().nullable().optional(),
  amountPaise: z.number().int().positive(),
  /** Claimable GST inside the amount (only with a GST bill). */
  gstPaise: z.number().int().min(0).optional(),
  fileId: z.string().uuid().nullable().optional(),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export async function recordExpense(shopId: string, raw: ExpenseInput, actorId: string) {
  const input = expenseSchema.parse(raw);
  const date = input.expenseDate ?? todayIst();
  if (date > todayIst()) throw validationFailed("The expense date is in the future.");
  const gst = input.gstPaise ?? 0;
  if (gst > input.amountPaise) throw validationFailed("GST cannot be more than the amount.");
  if (input.mode === "CREDIT" && !input.partyId) throw validationFailed("An unpaid expense needs the party you owe.");
  const party = input.partyId ? await getParty(shopId, input.partyId) : null;
  return db.transaction(async (tx) => {
    const [expense] = await tx
      .insert(accExpenses)
      .values({ shopId, category: input.category, description: input.description ?? null, expenseDate: date, mode: input.mode, partyId: party?.id ?? null, amountPaise: input.amountPaise, gstPaise: gst, fileId: input.fileId ?? null, createdBy: actorId })
      .returning();
    const credit: BookAccount = input.mode === "CREDIT" ? "PARTY" : cashAccount(input.mode);
    await postVoucher(
      {
        shopId,
        voucherType: "EXPENSE",
        entryDate: date,
        sourceType: "EXPENSE",
        sourceId: expense.id,
        narration: `${input.category.toLowerCase().replace(/_/g, " ")}${input.description ? `: ${input.description}` : ""}`,
        createdBy: actorId,
        legs: [
          { account: "EXPENSE", subAccount: input.category, debitPaise: input.amountPaise - gst },
          // Expense GST claimed as input credit is split equally CGST/SGST (local bills); the CA adjusts others.
          { account: "GST_INPUT_CGST", debitPaise: Math.ceil(gst / 2) },
          { account: "GST_INPUT_SGST", debitPaise: Math.floor(gst / 2) },
          { account: credit, partyId: credit === "PARTY" ? party!.id : null, creditPaise: input.amountPaise },
        ],
      },
      tx,
    );
    await logChange({ shopId, entityType: "expense", entityId: expense.id, action: "CREATE", snapshot: expense as unknown as Record<string, unknown>, actorId }, tx);
    return expense;
  });
}

export async function cancelExpense(shopId: string, expenseId: string, reason: string, actorId: string): Promise<void> {
  if (!reason.trim()) throw validationFailed("Say why the expense is cancelled.");
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(accExpenses).where(and(eq(accExpenses.id, expenseId), eq(accExpenses.shopId, shopId))).for("update");
    if (!e) throw notFound("Expense");
    if (e.status === "CANCELLED") throw conflict("Already cancelled.");
    await reverseSource(shopId, "EXPENSE", expenseId, todayIst(), actorId, `Expense cancelled: ${reason}`, tx);
    await tx.update(accExpenses).set({ status: "CANCELLED" }).where(eq(accExpenses.id, expenseId));
    await logChange({ shopId, entityType: "expense", entityId: expenseId, action: "CANCEL", reason, actorId }, tx);
  });
}

export async function listExpenses(shopId: string, options: { from?: string; to?: string } = {}) {
  return db
    .select()
    .from(accExpenses)
    .where(and(eq(accExpenses.shopId, shopId), options.from ? gte(accExpenses.expenseDate, options.from) : undefined, options.to ? lt(accExpenses.expenseDate, options.to) : undefined))
    .orderBy(desc(accExpenses.expenseDate), desc(accExpenses.createdAt))
    .limit(1000);
}

/* ------------------------------------------------------ cash book, day book */

export interface BookLine {
  id: string;
  entryDate: string;
  voucherType: AccLedgerEntry["voucherType"];
  account: AccLedgerEntry["account"];
  partyName: string | null;
  docRef: string | null;
  narration: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise?: number;
}

/** Cash or bank book between two dates, with opening and running balance. */
export async function cashBook(shopId: string, account: "CASH" | "BANK", from: string, to: string) {
  const [opening] = await db
    .select({ bal: sql<number>`coalesce(sum(${accLedgerEntries.debitPaise} - ${accLedgerEntries.creditPaise}), 0)::bigint` })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.account, account), lt(accLedgerEntries.entryDate, from)));
  const rows = await db
    .select({ e: accLedgerEntries, partyName: accParties.name })
    .from(accLedgerEntries)
    .leftJoin(accParties, eq(accLedgerEntries.partyId, accParties.id))
    .where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.account, account), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
    .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt));
  // The party of a cash leg is on the other legs of its voucher.
  const voucherIds = [...new Set(rows.map((r) => r.e.voucherId))];
  const partyLegs = voucherIds.length
    ? await db
        .select({ voucherId: accLedgerEntries.voucherId, name: accParties.name })
        .from(accLedgerEntries)
        .innerJoin(accParties, eq(accLedgerEntries.partyId, accParties.id))
        .where(inArray(accLedgerEntries.voucherId, voucherIds))
    : [];
  const partyOf = new Map(partyLegs.map((p) => [p.voucherId, p.name]));
  let balance = Number(opening?.bal ?? 0);
  const openingPaise = balance;
  const lines: BookLine[] = rows.map(({ e }) => {
    balance += e.debitPaise - e.creditPaise;
    return { id: e.id, entryDate: e.entryDate, voucherType: e.voucherType, account: e.account, partyName: partyOf.get(e.voucherId) ?? null, docRef: e.docRef, narration: e.narration, debitPaise: e.debitPaise, creditPaise: e.creditPaise, balancePaise: balance };
  });
  return { openingPaise, closingPaise: balance, lines, inPaise: lines.reduce((n, l) => n + l.debitPaise, 0), outPaise: lines.reduce((n, l) => n + l.creditPaise, 0) };
}

/** Every voucher of the day(s), grouped. */
export async function dayBook(shopId: string, from: string, to: string) {
  const rows = await db
    .select({ e: accLedgerEntries, partyName: accParties.name })
    .from(accLedgerEntries)
    .leftJoin(accParties, eq(accLedgerEntries.partyId, accParties.id))
    .where(and(eq(accLedgerEntries.shopId, shopId), gte(accLedgerEntries.entryDate, from), lt(accLedgerEntries.entryDate, to)))
    .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt), asc(accLedgerEntries.voucherId));
  const vouchers = new Map<string, { voucherId: string; entryDate: string; voucherType: AccLedgerEntry["voucherType"]; docRef: string | null; narration: string | null; legs: BookLine[] }>();
  for (const { e, partyName } of rows) {
    const v = vouchers.get(e.voucherId) ?? { voucherId: e.voucherId, entryDate: e.entryDate, voucherType: e.voucherType, docRef: e.docRef, narration: e.narration, legs: [] };
    v.legs.push({ id: e.id, entryDate: e.entryDate, voucherType: e.voucherType, account: e.account, partyName, docRef: e.docRef, narration: e.narration, debitPaise: e.debitPaise, creditPaise: e.creditPaise });
    vouchers.set(e.voucherId, v);
  }
  return [...vouchers.values()];
}

/** Trial balance per account (debits − credits) up to a date — used by tests and the Tally export. */
export async function trialBalance(shopId: string, until?: string) {
  const rows = await db
    .select({ account: accLedgerEntries.account, dr: sql<number>`sum(${accLedgerEntries.debitPaise})::bigint`, cr: sql<number>`sum(${accLedgerEntries.creditPaise})::bigint` })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), until ? lt(accLedgerEntries.entryDate, until) : undefined))
    .groupBy(accLedgerEntries.account);
  return rows.map((r) => ({ account: r.account, debitPaise: Number(r.dr), creditPaise: Number(r.cr) }));
}
