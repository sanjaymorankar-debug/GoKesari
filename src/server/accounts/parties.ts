/**
 * Suppliers and customers of a shop, their ledgers and ageing
 * (docs/inventory-accounting-2026-10, Part 2).
 *
 * A party's balance comes from its PARTY legs in acc_ledger_entries:
 * credit (a bill from a supplier) raises what the shop owes, debit (a payment
 * to them) lowers it; for customers the other way round. Positive balance =
 * the shop owes the party (payable); negative = the party owes the shop.
 */
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { isValidGstin } from "@/lib/gst-states";
import type { PartyKind } from "@/lib/accounts/constants";
import { stateOfGstin } from "@/lib/accounts/gst-math";
import { normaliseText } from "@/lib/accounts/text-match";
import { db, type DbClient } from "@/server/db";
import { accLedgerEntries, accParties, accPayments, accPurchaseInvoices, accSalesInvoices, type AccParty } from "@/server/db/schema";
import { logChange, postVoucher, todayIst } from "./books";

export const partySchema = z.object({
  kind: z.enum(["SUPPLIER", "CUSTOMER", "BOTH"]),
  name: z.string().trim().min(2).max(120),
  gstin: z.string().trim().toUpperCase().max(15).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().email().max(120).optional().nullable().or(z.literal("").transform(() => null)),
  address: z.string().trim().max(400).optional().nullable(),
  creditDays: z.number().int().min(0).max(365).optional(),
  openingBalancePaise: z.number().int().optional(),
});
export type PartyInput = z.infer<typeof partySchema>;

function cleanGstin(gstin: string | null | undefined): string | null {
  const g = (gstin ?? "").replace(/\s+/g, "").toUpperCase();
  if (!g) return null;
  if (!isValidGstin(g)) throw validationFailed("GSTIN is not valid (15 characters with a matching check digit).");
  return g;
}

export async function createParty(shopId: string, input: PartyInput, actorId: string, client: DbClient = db): Promise<AccParty> {
  const gstin = cleanGstin(input.gstin);
  if (gstin) {
    const [existing] = await client.select().from(accParties).where(and(eq(accParties.shopId, shopId), eq(accParties.gstin, gstin)));
    if (existing) throw conflict(`${existing.name} already has this GSTIN.`);
  }
  const run = async (tx: DbClient) => {
    const [party] = await tx
      .insert(accParties)
      .values({
        shopId,
        kind: input.kind,
        name: input.name,
        gstin,
        stateCode: stateOfGstin(gstin),
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        creditDays: input.creditDays ?? 0,
        openingBalancePaise: input.openingBalancePaise ?? 0,
        createdBy: actorId,
      })
      .returning();
    if (party.openingBalancePaise) {
      // Payable opening balance: Cr party / Dr capital; receivable: the reverse.
      const amt = party.openingBalancePaise;
      await postVoucher(
        {
          shopId,
          voucherType: "OPENING",
          entryDate: todayIst(),
          sourceType: "PARTY_OPENING",
          sourceId: party.id,
          narration: `Opening balance of ${party.name}`,
          createdBy: actorId,
          legs: [
            { account: "PARTY", partyId: party.id, creditPaise: amt },
            { account: "CAPITAL", debitPaise: amt },
          ],
        },
        tx,
      );
    }
    await logChange({ shopId, entityType: "party", entityId: party.id, action: "CREATE", snapshot: party as unknown as Record<string, unknown>, actorId }, tx);
    return party;
  };
  return client === db ? db.transaction(run) : run(client);
}

export async function updateParty(shopId: string, partyId: string, input: Partial<PartyInput>, actorId: string): Promise<AccParty> {
  const party = await getParty(shopId, partyId);
  const gstin = input.gstin !== undefined ? cleanGstin(input.gstin) : party.gstin;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(accParties)
      .set({
        kind: input.kind ?? party.kind,
        name: input.name ?? party.name,
        gstin,
        stateCode: stateOfGstin(gstin),
        phone: input.phone !== undefined ? input.phone : party.phone,
        email: input.email !== undefined ? input.email : party.email,
        address: input.address !== undefined ? input.address : party.address,
        creditDays: input.creditDays ?? party.creditDays,
        updatedAt: new Date(),
      })
      .where(and(eq(accParties.id, partyId), eq(accParties.shopId, shopId)))
      .returning();
    const fields = ["kind", "name", "gstin", "phone", "email", "address", "creditDays"] as const;
    const changes = fields.filter((k) => party[k] !== row[k]).map((k) => ({ field: k, old: party[k], new: row[k] }));
    if (changes.length) await logChange({ shopId, entityType: "party", entityId: partyId, action: "UPDATE", changes, actorId }, tx);
    return row;
  });
}

export async function getParty(shopId: string, partyId: string, client: DbClient = db): Promise<AccParty> {
  const [party] = await client.select().from(accParties).where(and(eq(accParties.id, partyId), eq(accParties.shopId, shopId)));
  if (!party) throw notFound("Party");
  return party;
}

/**
 * The supplier of a bill: by GSTIN, else by exact (normalised) name, else a
 * new SUPPLIER party. A customer party with the same GSTIN becomes BOTH.
 */
export async function findOrCreateSupplier(shopId: string, supplier: { partyId?: string | null; name: string; gstin: string | null }, actorId: string, client: DbClient): Promise<AccParty> {
  if (supplier.partyId) return getParty(shopId, supplier.partyId, client);
  const gstin = cleanGstin(supplier.gstin);
  if (gstin) {
    const [existing] = await client.select().from(accParties).where(and(eq(accParties.shopId, shopId), eq(accParties.gstin, gstin)));
    if (existing) {
      if (existing.kind === "CUSTOMER") await client.update(accParties).set({ kind: "BOTH", updatedAt: new Date() }).where(eq(accParties.id, existing.id));
      return existing;
    }
  } else {
    const candidates = await client.select().from(accParties).where(and(eq(accParties.shopId, shopId), ilike(accParties.name, supplier.name.trim())));
    const same = candidates.find((p) => normaliseText(p.name) === normaliseText(supplier.name) && p.kind !== "CUSTOMER");
    if (same) return same;
  }
  return createParty(shopId, { kind: "SUPPLIER", name: supplier.name.trim(), gstin }, actorId, client);
}

export async function listParties(shopId: string, kind?: PartyKind | "ALL") {
  const parties = await db
    .select()
    .from(accParties)
    .where(and(eq(accParties.shopId, shopId), kind && kind !== "ALL" ? sql`${accParties.kind} IN (${kind}, 'BOTH')` : undefined))
    .orderBy(asc(accParties.name));
  const balances = await db
    .select({ partyId: accLedgerEntries.partyId, balance: sql<number>`coalesce(sum(${accLedgerEntries.creditPaise} - ${accLedgerEntries.debitPaise}), 0)::bigint` })
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.account, "PARTY")))
    .groupBy(accLedgerEntries.partyId);
  const map = new Map(balances.map((b) => [b.partyId, Number(b.balance)]));
  return parties.map((p) => ({ ...p, balancePaise: map.get(p.id) ?? 0 }));
}

/** The party's account: every leg with the running balance (oldest first). */
export async function partyLedger(shopId: string, partyId: string) {
  const party = await getParty(shopId, partyId);
  const rows = await db
    .select()
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.account, "PARTY"), eq(accLedgerEntries.partyId, partyId)))
    .orderBy(asc(accLedgerEntries.entryDate), asc(accLedgerEntries.createdAt));
  let balance = 0;
  const lines = rows.map((r) => {
    balance += r.creditPaise - r.debitPaise;
    return { id: r.id, entryDate: r.entryDate, voucherType: r.voucherType, docRef: r.docRef, narration: r.narration, debitPaise: r.debitPaise, creditPaise: r.creditPaise, balancePaise: balance, sourceType: r.sourceType, sourceId: r.sourceId };
  });
  return { party, lines, balancePaise: balance };
}

/* ------------------------------------------------------------- ageing */

export interface AgeingRow {
  partyId: string;
  name: string;
  kind: PartyKind;
  totalPaise: number;
  buckets: { current: number; d30: number; d60: number; d90: number; over90: number };
  oldestDueDate: string | null;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Payables (bills not yet paid) or receivables (own invoices not yet
 * received), by age past the due date: 0–30, 31–60, 61–90, 90+ days.
 * Payments are applied to the party's oldest bills first unless they name one.
 */
export async function ageing(shopId: string, side: "PAYABLE" | "RECEIVABLE", asOf = todayIst()): Promise<AgeingRow[]> {
  const parties = await db.select().from(accParties).where(eq(accParties.shopId, shopId));
  const docs =
    side === "PAYABLE"
      ? (await db.select().from(accPurchaseInvoices).where(and(eq(accPurchaseInvoices.shopId, shopId), eq(accPurchaseInvoices.status, "CONFIRMED"))).orderBy(asc(accPurchaseInvoices.invoiceDate))).map((d) => ({
          id: d.id,
          partyId: d.partyId,
          date: d.invoiceDate,
          due: d.dueDate ?? d.invoiceDate,
          total: d.totalPaise,
        }))
      : (await db.select().from(accSalesInvoices).where(and(eq(accSalesInvoices.shopId, shopId), eq(accSalesInvoices.status, "ISSUED"), eq(accSalesInvoices.paymentMode, "CREDIT"))).orderBy(asc(accSalesInvoices.invoiceDate))).filter((d) => d.partyId).map((d) => ({
          id: d.id,
          partyId: d.partyId!,
          date: d.invoiceDate,
          due: d.dueDate ?? d.invoiceDate,
          total: d.totalPaise,
        }));
  const payments = await db
    .select()
    .from(accPayments)
    .where(and(eq(accPayments.shopId, shopId), eq(accPayments.status, "ACTIVE"), eq(accPayments.direction, side === "PAYABLE" ? "PAID" : "RECEIVED")))
    .orderBy(asc(accPayments.paymentDate), desc(accPayments.amountPaise));
  const open = new Map(docs.map((d) => [d.id, d.total]));
  const unapplied = new Map<string, number>();
  for (const p of payments) {
    const named = side === "PAYABLE" ? p.purchaseInvoiceId : p.salesInvoiceId;
    let left = p.amountPaise;
    if (named && open.has(named)) {
      const take = Math.min(left, open.get(named)!);
      open.set(named, open.get(named)! - take);
      left -= take;
    }
    unapplied.set(p.partyId, (unapplied.get(p.partyId) ?? 0) + left);
  }
  for (const d of docs) {
    const left = unapplied.get(d.partyId) ?? 0;
    if (left <= 0) continue;
    const take = Math.min(left, open.get(d.id) ?? 0);
    open.set(d.id, (open.get(d.id) ?? 0) - take);
    unapplied.set(d.partyId, left - take);
  }
  const rows = new Map<string, AgeingRow>();
  for (const d of docs) {
    const amount = open.get(d.id) ?? 0;
    if (amount <= 0) continue;
    const party = parties.find((p) => p.id === d.partyId);
    if (!party) continue;
    const row = rows.get(d.partyId) ?? { partyId: d.partyId, name: party.name, kind: party.kind, totalPaise: 0, buckets: { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 }, oldestDueDate: null };
    const late = daysBetween(d.due, asOf);
    if (late <= 0) row.buckets.current += amount;
    else if (late <= 30) row.buckets.d30 += amount;
    else if (late <= 60) row.buckets.d60 += amount;
    else if (late <= 90) row.buckets.d90 += amount;
    else row.buckets.over90 += amount;
    row.totalPaise += amount;
    row.oldestDueDate = row.oldestDueDate && row.oldestDueDate < d.due ? row.oldestDueDate : d.due;
    rows.set(d.partyId, row);
  }
  return [...rows.values()].sort((a, b) => b.totalPaise - a.totalPaise);
}
