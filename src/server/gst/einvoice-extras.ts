/**
 * E-invoice and e-way bill additions (billing v2, docs/billing §9.7, §9.8):
 *
 *   - an IRN can be cancelled only within 24 hours of its acknowledgement
 *     (after that: a credit note);
 *   - shops with aggregate turnover of ₹10 crore and above must report an
 *     invoice to the IRP within the reporting window (rule
 *     einvoiceReportingWindow, 30 days) — later requests are refused;
 *   - a credit note against an e-invoiced B2B invoice gets its own IRN (CRN);
 *   - an e-way bill's Part B (vehicle) can be updated, its validity extended
 *     (from 8 hours before to 8 hours after expiry) and the bill cancelled
 *     within 24 hours of generation.
 *
 * Every GSP call goes through callGsp (logged, retried, rate-limited).
 */
import { eq } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { creditNoteEinvoices, creditNotes, einvoiceRecords, ewayBills, shops, type TaxInvoice } from "@/server/db/schema";
import { creditNoteToCanonical } from "@/server/integrations/documents";
import { callGsp } from "@/server/gsp/calls";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getGspProvider } from "./gsp";
import { GspError } from "./gsp/types";
import { getGstRule } from "./rules";

const HOURS_24 = 24 * 3600_000;
const HOURS_8 = 8 * 3600_000;

type Reason = "1" | "2" | "3" | "4";

/** §9.7: large taxpayers (₹10 crore+) report within the window; refused after it. */
export async function assertWithinReportingWindow(invoice: Pick<TaxInvoice, "shopId" | "issuedAt" | "invoiceNumber">, now = new Date()): Promise<void> {
  const window = await getGstRule<{ days: number; appliesAbovePaise: number }>("einvoiceReportingWindow", invoice.issuedAt);
  if (!window) return;
  const [shop] = await db.select({ band: shops.declaredTurnoverBand }).from(shops).where(eq(shops.id, invoice.shopId));
  const large = shop?.band === "10_TO_100_CR" || shop?.band === "ABOVE_100_CR";
  if (!large) return;
  if (now.getTime() - invoice.issuedAt.getTime() > window.days * 86_400_000) {
    throw validationFailed(`Invoice ${invoice.invoiceNumber} is more than ${window.days} days old: the IRP does not accept it for a taxpayer with turnover of ₹10 crore or more. Issue a fresh invoice (and cancel this one) after checking with your CA.`);
  }
}

export async function cancelEinvoice(invoiceId: string, reason: Reason, remark: string, actor: { id: string }): Promise<void> {
  const [record] = await db.select().from(einvoiceRecords).where(eq(einvoiceRecords.taxInvoiceId, invoiceId));
  if (!record || record.status !== "GENERATED" || !record.irn) throw conflict("This invoice has no live e-invoice (IRN).");
  if (!record.ackDate || Date.now() - record.ackDate.getTime() > HOURS_24) throw conflict("An IRN can be cancelled only within 24 hours of generation. Issue a credit note instead.");
  if (remark.trim().length < 3) throw validationFailed("Say why the e-invoice is cancelled.");
  const gsp = getGspProvider();
  const { cancelledAt } = await callGsp({ operation: "irn:cancel", provider: gsp.name, shopId: record.shopId, actorId: actor.id }, () => gsp.cancelIrn(record.irn!, reason, remark.trim()));
  await db.update(einvoiceRecords).set({ status: "CANCELLED", cancelledAt: new Date(cancelledAt), cancelReason: remark.trim(), updatedAt: new Date() }).where(eq(einvoiceRecords.id, record.id));
  await recordAudit({ actorId: actor.id, action: AUDIT_ACTIONS.EINVOICE_CANCELLED, entityType: "tax_invoice", entityId: invoiceId, newValue: { irn: record.irn, reason, remark } });
}

/** A credit note's IRN, when its invoice was e-invoiced. Returns null when none is due. */
export async function requestCreditNoteEinvoice(creditNoteId: string, actor: { id: string } | null = null) {
  const [note] = await db.select().from(creditNotes).where(eq(creditNotes.id, creditNoteId));
  if (!note) throw notFound("Credit note");
  const [inv] = await db.select().from(einvoiceRecords).where(eq(einvoiceRecords.taxInvoiceId, note.taxInvoiceId));
  if (!inv || inv.status !== "GENERATED") return null;
  let [row] = await db.select().from(creditNoteEinvoices).where(eq(creditNoteEinvoices.creditNoteId, creditNoteId));
  if (row?.status === "GENERATED") return row;
  row ??= (await db.insert(creditNoteEinvoices).values({ creditNoteId, shopId: note.shopId }).onConflictDoNothing().returning())[0] ?? (await db.select().from(creditNoteEinvoices).where(eq(creditNoteEinvoices.creditNoteId, creditNoteId)))[0];
  const gsp = getGspProvider();
  try {
    const doc = creditNoteToCanonical(note, new Map());
    const result = await callGsp({ operation: "irn:credit-note", provider: gsp.name, shopId: note.shopId, actorId: actor?.id ?? null }, () =>
      gsp.generateIrn({ requestId: `irn-crn:${note.id}`, invoice: doc as unknown as Parameters<typeof gsp.generateIrn>[0]["invoice"], docType: "CRN" }),
    );
    const [done] = await db
      .update(creditNoteEinvoices)
      .set({ status: "GENERATED", irn: result.irn, ackNo: result.ackNo, ackDate: new Date(result.ackDate), signedQr: result.signedQr, errorMessage: null, updatedAt: new Date() })
      .where(eq(creditNoteEinvoices.id, row.id))
      .returning();
    await recordAudit({ actorId: actor?.id ?? null, action: AUDIT_ACTIONS.EINVOICE_GENERATED, entityType: "credit_note", entityId: note.id, newValue: { irn: result.irn, creditNoteNumber: note.creditNoteNumber } });
    return done;
  } catch (error) {
    const message = error instanceof GspError ? error.message : error instanceof Error ? error.message : String(error);
    const [failed] = await db.update(creditNoteEinvoices).set({ status: "FAILED", errorMessage: message, updatedAt: new Date() }).where(eq(creditNoteEinvoices.id, row.id)).returning();
    return failed;
  }
}

/* ------------------------------------------------------------ e-way bills */

async function liveEwayBill(invoiceId: string) {
  const [bill] = await db.select().from(ewayBills).where(eq(ewayBills.taxInvoiceId, invoiceId));
  if (!bill || bill.status !== "GENERATED" || !bill.ewbNo) throw conflict("This invoice has no live e-way bill.");
  return bill;
}

export async function updateEwayPartB(invoiceId: string, vehicleNo: string, reason: Reason, remark: string, actor: { id: string }) {
  const bill = await liveEwayBill(invoiceId);
  const vehicle = vehicleNo.replace(/\s+/g, "").toUpperCase();
  const gsp = getGspProvider();
  const { validUpto } = await callGsp({ operation: "ewb:part-b", provider: gsp.name, shopId: bill.shopId, actorId: actor.id }, () => gsp.updateEwayPartB(bill.ewbNo!, vehicle, reason, remark));
  const [row] = await db.update(ewayBills).set({ vehicleNo: vehicle, validUpto: new Date(validUpto), partBUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(ewayBills.id, bill.id)).returning();
  return row;
}

export async function extendEwayBill(invoiceId: string, remainingKm: number, reason: Reason | "99", remark: string, actor: { id: string }, now = new Date()) {
  const bill = await liveEwayBill(invoiceId);
  const expiry = bill.validUpto?.getTime() ?? 0;
  if (now.getTime() < expiry - HOURS_8 || now.getTime() > expiry + HOURS_8) throw conflict("An e-way bill can be extended only from 8 hours before to 8 hours after it expires.");
  if (!(remainingKm > 0 && remainingKm <= 4000)) throw validationFailed("Remaining distance: 1 to 4000 km.");
  const gsp = getGspProvider();
  const { validUpto } = await callGsp({ operation: "ewb:extend", provider: gsp.name, shopId: bill.shopId, actorId: actor.id }, () => gsp.extendEwayBill(bill.ewbNo!, remainingKm, reason, remark));
  const [row] = await db.update(ewayBills).set({ validUpto: new Date(validUpto), extensions: bill.extensions + 1, updatedAt: new Date() }).where(eq(ewayBills.id, bill.id)).returning();
  return row;
}

export async function cancelEwayBill(invoiceId: string, reason: Reason, remark: string, actor: { id: string }) {
  const bill = await liveEwayBill(invoiceId);
  if (Date.now() - bill.createdAt.getTime() > HOURS_24) throw conflict("An e-way bill can be cancelled only within 24 hours of generation.");
  const gsp = getGspProvider();
  await callGsp({ operation: "ewb:cancel", provider: gsp.name, shopId: bill.shopId, actorId: actor.id }, () => gsp.cancelEwayBill(bill.ewbNo!, reason, remark));
  const [row] = await db.update(ewayBills).set({ status: "CANCELLED", cancelledAt: new Date(), cancelReason: remark, updatedAt: new Date() }).where(eq(ewayBills.id, bill.id)).returning();
  return row;
}


/** Daily: IRNs for credit notes against e-invoiced invoices that have none yet (or failed). */
export async function issuePendingCreditNoteEinvoices(limit = 50): Promise<{ generated: number; failed: number }> {
  const { and: andOp, inArray, isNull, or: orOp } = await import("drizzle-orm");
  const due = await db
    .select({ id: creditNotes.id })
    .from(creditNotes)
    .innerJoin(einvoiceRecords, eq(einvoiceRecords.taxInvoiceId, creditNotes.taxInvoiceId))
    .leftJoin(creditNoteEinvoices, eq(creditNoteEinvoices.creditNoteId, creditNotes.id))
    .where(andOp(eq(einvoiceRecords.status, "GENERATED"), orOp(isNull(creditNoteEinvoices.id), inArray(creditNoteEinvoices.status, ["PENDING", "FAILED"]))))
    .limit(limit);
  let generated = 0;
  let failed = 0;
  for (const { id } of due) {
    const row = await requestCreditNoteEinvoice(id).catch(() => null);
    if (row?.status === "GENERATED") generated += 1;
    else failed += 1;
  }
  return { generated, failed };
}
