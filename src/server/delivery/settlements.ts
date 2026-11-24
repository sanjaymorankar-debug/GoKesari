/**
 * Delivery Settlement + Reconciliation (docs/hdms-2026-11).
 * A settlement is what GoKesari owes one partner for a period: every DELIVERED / RETURNED booking (and
 * cancelled ones that carried a fee), at the final fee when the partner sent one, else the quoted fee.
 * Reconciling compares the partner's invoice lines (reference + amount, CSV) with our bookings.
 * Paying the partner is outside this module (finance pays the invoice; its reference is recorded here).
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { deliveryBookings, deliveryReconciliationLines, deliverySettlements, type DeliveryProviderCode, type DeliverySettlement } from "@/server/db/hdms-schema";

function bookingCost(b: { finalFeePaise: number | null; quotedFeePaise: number | null }): number {
  return b.finalFeePaise ?? b.quotedFeePaise ?? 0;
}

async function payableBookings(providerCode: DeliveryProviderCode, periodStart: string, periodEnd: string) {
  return db
    .select()
    .from(deliveryBookings)
    .where(
      and(
        eq(deliveryBookings.providerCode, providerCode),
        sql`(${deliveryBookings.terminalAt} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${periodStart}::date AND ${periodEnd}::date`,
        or(
          inArray(deliveryBookings.status, ["DELIVERED", "RETURNED"]),
          and(eq(deliveryBookings.status, "CANCELLED"), sql`coalesce(${deliveryBookings.finalFeePaise}, 0) > 0`),
        ),
      ),
    );
}

export async function createSettlement(providerCode: DeliveryProviderCode, periodStart: string, periodEnd: string, actorId: string): Promise<DeliverySettlement> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
    throw validationFailed("Give the period as two dates, start not after end.");
  }
  const rows = await payableBookings(providerCode, periodStart, periodEnd);
  const expected = rows.reduce((s, b) => s + bookingCost(b), 0);
  const [created] = await db
    .insert(deliverySettlements)
    .values({ providerCode, periodStart, periodEnd, bookingCount: rows.length, expectedPaise: expected, createdBy: actorId })
    .onConflictDoNothing()
    .returning();
  if (!created) throw conflict("A settlement for this partner and period already exists.");
  return created;
}

/** Parses "reference,amount_in_rupees" lines (header optional). */
export function parseInvoiceCsv(text: string): { ref: string; paise: number }[] {
  const out: { ref: string; paise: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [ref, amount] = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const rupees = Number(amount?.replace(/[₹,\s]/g, ""));
    if (!ref || !Number.isFinite(rupees)) {
      if (out.length === 0) continue; // header row
      throw validationFailed(`Line "${line.slice(0, 60)}" is not "reference,amount".`);
    }
    out.push({ ref, paise: Math.round(rupees * 100) });
  }
  return out;
}

export async function reconcileSettlement(settlementId: string, invoiceCsv: string, invoiceRef: string | null): Promise<DeliverySettlement> {
  const [settlement] = await db.select().from(deliverySettlements).where(eq(deliverySettlements.id, settlementId));
  if (!settlement) throw notFound("Settlement");
  if (settlement.status === "PAID") throw conflict("This settlement is already paid.");
  const lines = parseInvoiceCsv(invoiceCsv);
  const bookings = await payableBookings(settlement.providerCode, settlement.periodStart, settlement.periodEnd);
  const byRef = new Map(bookings.filter((b) => b.externalRef).map((b) => [b.externalRef!, b]));
  const seen = new Set<string>();
  const out: (typeof deliveryReconciliationLines.$inferInsert)[] = [];
  for (const l of lines) {
    const b = byRef.get(l.ref);
    if (!b) {
      out.push({ settlementId, externalRef: l.ref, invoicedPaise: l.paise, result: "UNKNOWN_BOOKING" });
      continue;
    }
    seen.add(l.ref);
    const expected = bookingCost(b);
    out.push({ settlementId, bookingId: b.id, externalRef: l.ref, expectedPaise: expected, invoicedPaise: l.paise, result: expected === l.paise ? "MATCHED" : "AMOUNT_MISMATCH" });
  }
  for (const b of bookings) {
    if (b.externalRef && !seen.has(b.externalRef)) {
      out.push({ settlementId, bookingId: b.id, externalRef: b.externalRef, expectedPaise: bookingCost(b), invoicedPaise: null, result: "NOT_IN_INVOICE" });
    }
  }
  const invoiced = lines.reduce((s, l) => s + l.paise, 0);
  const expected = bookings.reduce((s, b) => s + bookingCost(b), 0);
  const clean = out.every((l) => l.result === "MATCHED");
  return db.transaction(async (tx) => {
    await tx.delete(deliveryReconciliationLines).where(eq(deliveryReconciliationLines.settlementId, settlementId));
    if (out.length) await tx.insert(deliveryReconciliationLines).values(out);
    const [updated] = await tx
      .update(deliverySettlements)
      .set({
        bookingCount: bookings.length,
        expectedPaise: expected,
        invoicedPaise: invoiced,
        differencePaise: invoiced - expected,
        invoiceRef: invoiceRef?.slice(0, 100) ?? settlement.invoiceRef,
        status: clean ? "RECONCILED" : "DISPUTED",
        updatedAt: new Date(),
      })
      .where(eq(deliverySettlements.id, settlementId))
      .returning();
    return updated;
  });
}

export async function markSettlementPaid(settlementId: string, paidRef: string): Promise<DeliverySettlement> {
  const [row] = await db
    .update(deliverySettlements)
    .set({ status: "PAID", paidRef: paidRef.slice(0, 100), updatedAt: new Date() })
    .where(and(eq(deliverySettlements.id, settlementId), inArray(deliverySettlements.status, ["RECONCILED", "DISPUTED"])))
    .returning();
  if (!row) throw conflict("Reconcile the settlement before marking it paid.");
  return row;
}

export async function listSettlements(): Promise<DeliverySettlement[]> {
  return db.select().from(deliverySettlements).orderBy(sql`${deliverySettlements.periodEnd} DESC`).limit(100);
}

export async function settlementLines(settlementId: string) {
  return db.select().from(deliveryReconciliationLines).where(eq(deliveryReconciliationLines.settlementId, settlementId));
}
