/**
 * Flow spec v3, wave 4 — F22 commission held, taxed and invoiced (docs/flows-v3/wave4.md; flag flow_f22; the callers
 * check the flag). With the flag off none of this runs and the monthly close is exactly as before.
 *
 *  - Holding: an entry becomes payable `commissionHoldDays` after it is earned (rule franchiseFlowsV3; owner
 *    27-Nov-2026: the return window + 1 day = 3 days). Newer entries stay EARNED for the next month's close.
 *  - GST: a dealer with a valid GSTIN is a registered supplier of his commission service to GoKesari — the payout
 *    adds GST at `commissionGstRateBp` (CGST + SGST inside GoKesari's state, else IGST) and a commission invoice is
 *    issued for it, numbered per financial year like the platform invoices (same number format and tax split).
 *    Team members are paid without GST (no GSTIN is kept for them). TDS is unchanged: on the commission, not the GST.
 *  - Clawback when a shop fee is refunded through the payment gateway: the chain's commission is reversed as when
 *    the refund is recorded by hand (reverseShopCommission), after the refund has settled.
 */
import { and, eq, sql } from "drizzle-orm";

import { gstState, isValidGstin } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { textPdf, type PdfLine } from "@/lib/pdf";
import { db, type DbClient } from "@/server/db";
import { dealerCommissionInvoiceCounters, dealerCommissionInvoices, dealerPayoutBatches, dealers, shopRegistrationDrafts, shops, type DealerCommissionInvoice, type DealerPayoutBatch } from "@/server/db/schema";
import { formatPlatformDocNumber, gstOnTaxable } from "@/server/platform-invoices/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { amountInWords, financialYearOf } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";
import { commissionPayableBefore, flow4On, wave4Rule } from "./wave4";

/** The cut-off for the month close: entries created before it are payable (null with the flag off = no hold). */
export async function commissionHoldCutoff(now: Date): Promise<Date | null> {
  if (!(await flow4On("flow_f22"))) return null;
  return commissionPayableBefore(now, (await wave4Rule()).commissionHoldDays);
}

export interface CommissionGst {
  gstPaise: number;
  rateBp: number;
  supply: "INTRA" | "INTER";
  gstin: string;
}

/** GST on a payout to a GST-registered dealer (none for a team member, an unregistered dealer or a net ≤ 0). */
export async function commissionGstFor(client: DbClient, dealerId: string, memberId: string | null, totalPaise: number): Promise<CommissionGst | null> {
  if (memberId || totalPaise <= 0) return null;
  const [dealer] = await client.select({ gstin: dealers.gstin }).from(dealers).where(eq(dealers.id, dealerId));
  if (!dealer || !isValidGstin(dealer.gstin)) return null;
  const rule = await wave4Rule();
  if (rule.commissionGstRateBp <= 0) return null;
  const profile = await getRule("platformTaxProfile");
  const ours = gstState(profile.stateCode)?.alpha ?? (isValidGstin(profile.gstin) ? gstState(profile.gstin)?.alpha : null) ?? null;
  const theirs = gstState(dealer.gstin)?.alpha ?? null;
  // DEFAULT – confirm with Sanjay: when GoKesari's state is not set, the supply counts as inter-state (IGST).
  const supply = ours && theirs && ours === theirs ? "INTRA" : "INTER";
  const tax = gstOnTaxable(totalPaise, rule.commissionGstRateBp, supply);
  return { gstPaise: tax.cgstPaise + tax.sgstPaise + tax.igstPaise, rateBp: rule.commissionGstRateBp, supply, gstin: dealer.gstin!.trim().toUpperCase() };
}

async function nextInvoiceNumber(client: DbClient, prefix: string, financialYear: string): Promise<number> {
  const [row] = await client
    .insert(dealerCommissionInvoiceCounters)
    .values({ prefix, financialYear, lastNumber: 1 })
    .onConflictDoUpdate({ target: [dealerCommissionInvoiceCounters.prefix, dealerCommissionInvoiceCounters.financialYear], set: { lastNumber: sql`${dealerCommissionInvoiceCounters.lastNumber} + 1`, updatedAt: new Date() } })
    .returning({ lastNumber: dealerCommissionInvoiceCounters.lastNumber });
  return row.lastNumber;
}

/** Issues the commission invoice of a payout drafted with GST (in the caller's transaction); idempotent per payout. */
export async function issueCommissionInvoice(client: DbClient, batch: DealerPayoutBatch, gst: CommissionGst, issuedAt: Date): Promise<DealerCommissionInvoice> {
  const [existing] = await client.select().from(dealerCommissionInvoices).where(eq(dealerCommissionInvoices.batchId, batch.id));
  if (existing) return existing;
  const rule = await wave4Rule();
  const profile = await getRule("platformTaxProfile");
  const [dealer] = await client.select().from(dealers).where(eq(dealers.id, batch.dealerId));
  const financialYear = financialYearOf(issuedAt);
  const invoiceNumber = formatPlatformDocNumber(rule.commissionInvoicePrefix, financialYear, await nextInvoiceNumber(client, rule.commissionInvoicePrefix, financialYear));
  const tax = gstOnTaxable(batch.totalPaise, gst.rateBp, gst.supply);
  const totalPaise = batch.totalPaise + gst.gstPaise;
  const address = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ") || null;
  const [invoice] = await client
    .insert(dealerCommissionInvoices)
    .values({
      batchId: batch.id,
      dealerId: batch.dealerId,
      invoiceNumber,
      financialYear,
      periodMonth: batch.periodMonth,
      supplierGstin: gst.gstin,
      supply: gst.supply,
      taxablePaise: batch.totalPaise,
      gstRateBp: gst.rateBp,
      ...tax,
      totalPaise,
      snapshot: {
        supplier: { name: dealer?.legalName ?? "", gstin: gst.gstin, address: address([dealer?.addressLine1, dealer?.addressLine2, dealer?.city, dealer?.pincode]), state: gstState(gst.gstin)?.name ?? dealer?.state ?? null },
        recipient: { name: profile.legalName, gstin: isValidGstin(profile.gstin) ? profile.gstin : null, address: profile.address || null, state: gstState(profile.stateCode)?.name ?? null },
        description: `Referral and onboarding commission${batch.periodMonth ? ` for ${batch.periodMonth}` : ""}`,
        sac: rule.commissionSac,
        periodMonth: batch.periodMonth,
        amountInWords: amountInWords(totalPaise),
      },
      issuedAt,
    })
    .returning();
  await client.update(dealerPayoutBatches).set({ gstInvoiceId: invoice.id }).where(eq(dealerPayoutBatches.id, batch.id));
  await recordAudit({ action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batch.id, newValue: { commissionInvoice: invoiceNumber, gstPaise: gst.gstPaise, supply: gst.supply, rateBp: gst.rateBp } }, client);
  return invoice;
}

/** The commission invoice as a PDF (the dealer's own copy and GoKesari's record). */
export function renderCommissionInvoicePdf(invoice: DealerCommissionInvoice): Buffer {
  const s = invoice.snapshot;
  const lines: PdfLine[] = [
    { text: "TAX INVOICE (commission)", bold: true },
    { text: `Invoice ${invoice.invoiceNumber} · ${invoice.issuedAt.toISOString().slice(0, 10)}` },
    { text: "" },
    { text: `Supplier: ${s.supplier.name} · GSTIN ${s.supplier.gstin}`, bold: true },
    ...(s.supplier.address ? [{ text: s.supplier.address }] : []),
    { text: `Recipient: ${s.recipient.name}${s.recipient.gstin ? ` · GSTIN ${s.recipient.gstin}` : ""}` },
    ...(s.recipient.address ? [{ text: s.recipient.address }] : []),
    { text: "" },
    { text: `${s.description} · SAC ${s.sac}` },
    { text: `Taxable value: ${formatPaise(invoice.taxablePaise)}` },
    ...(invoice.supply === "INTRA"
      ? [{ text: `CGST ${invoice.gstRateBp / 200}%: ${formatPaise(invoice.cgstPaise)}` }, { text: `SGST ${invoice.gstRateBp / 200}%: ${formatPaise(invoice.sgstPaise)}` }]
      : [{ text: `IGST ${invoice.gstRateBp / 100}%: ${formatPaise(invoice.igstPaise)}` }]),
    { text: `Total: ${formatPaise(invoice.totalPaise)}`, bold: true },
    { text: `(${s.amountInWords})` },
    { text: "" },
    { text: "Issued by GoKesari on the supplier's behalf from the monthly commission statement." },
  ];
  return textPdf(lines);
}

/**
 * F22: a shop fee refunded in full through the payment gateway takes back the commission of everyone in the chain
 * (the same reversal as a refund recorded by hand). Called after the refund settled; never throws.
 */
export async function clawBackShopFeeRefund(intent: { purpose: string; referenceId: string; amountPaise: number; refundedPaise: number }): Promise<void> {
  if (!["SHOP_REGISTRATION_FEE", "SHOP_REGISTRATION_DRAFT_FEE"].includes(intent.purpose)) return;
  if (intent.refundedPaise < intent.amountPaise) return; // DEFAULT – confirm with Sanjay: a part refund keeps the commission.
  if (!(await flow4On("flow_f22"))) return;
  try {
    const shopId = await shopOfFeeIntent(intent.purpose, intent.referenceId);
    if (!shopId) return;
    const { reverseShopCommissionSafely } = await import("@/server/dealers/commission");
    await reverseShopCommissionSafely(shopId, "registration fee refunded through the payment gateway", null);
  } catch (error) {
    console.error("[f22] commission clawback after a fee refund failed", intent.referenceId, error);
  }
}

async function shopOfFeeIntent(purpose: string, referenceId: string): Promise<string | null> {
  if (purpose === "SHOP_REGISTRATION_FEE") {
    const [s] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, referenceId));
    return s?.id ?? null;
  }
  // The registration draft's shop (onboarding v2), once the shop exists.
  const [d] = await db.select({ shopId: shopRegistrationDrafts.shopId }).from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, referenceId));
  return d?.shopId ?? null;
}

/** For tests and admin views: a payout's commission invoice, if any. */
export async function commissionInvoiceForBatch(batchId: string): Promise<DealerCommissionInvoice | null> {
  const [row] = await db.select().from(dealerCommissionInvoices).where(and(eq(dealerCommissionInvoices.batchId, batchId)));
  return row ?? null;
}
