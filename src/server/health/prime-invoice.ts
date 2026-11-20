/**
 * GoKesari Health Prime: the GST tax invoice for a paid plan (GoKesari is the supplier).
 *
 * Supplier details (legal / trade name, GSTIN, PAN, address, state, SAC) come from the same rule as
 * GoKesari's own platform invoices (platformTaxProfile, Admin → Settings), so there is one GST identity.
 * The plan price is the taxable value (after any coupon); GST at the rate charged (rule
 * health.primeGstBp, 18%) is shown on its own line — CGST + SGST when the shop is in GoKesari's state,
 * IGST otherwise (place of supply = the shop's state). Number: PRIME/<FY>/<000001>, given when the
 * payment is captured (prime.ts). The PDF is the plain-text invoice writer used for platform invoices.
 */
import { and, eq } from "drizzle-orm";

import { gstState, isValidGstin, stateLabel } from "@/lib/gst-states";
import { PRIME_TIER_LABELS, type PrimeTier } from "@/lib/health/constants";
import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { qrMatrix } from "@/lib/qr";
import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { healthEvents, healthPrimePlans, healthPrimeSubscriptions, paymentIntents, shops } from "@/server/db/schema";
import { shopStateCode } from "@/server/platform-invoices/service";
import { amountInWords } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";
import type { HealthActor } from "./access";
import { requirePrimeAccess } from "./prime";

export interface PrimeInvoice {
  invoiceNumber: string;
  issuedAt: string;
  supplier: { legalName: string; tradeName: string; gstin: string; pan: string; address: string; stateCode: string; email: string; sac: string };
  recipient: { name: string; legalName: string; gstin: string | null; address: string; stateCode: string | null; registrationNumber: string };
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string | null;
  line: { description: string; period: string; pricePaise: number; discountPaise: number; couponCode: string | null };
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  totalPaise: number;
}

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const fmtDate = (d: Date | string) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** The invoice data for a paid subscription (owner of the shop or Health staff). */
export async function primeInvoice(subscriptionId: string, actor: HealthActor): Promise<PrimeInvoice> {
  const [row] = await db
    .select({ s: healthPrimeSubscriptions, plan: healthPrimePlans, shop: shops })
    .from(healthPrimeSubscriptions)
    .innerJoin(healthPrimePlans, eq(healthPrimePlans.id, healthPrimeSubscriptions.planId))
    .innerJoin(shops, eq(shops.id, healthPrimeSubscriptions.shopId))
    .where(eq(healthPrimeSubscriptions.id, subscriptionId));
  if (!row || !row.s.invoiceNumber) throw notFound("Invoice");
  await requirePrimeAccess(row.s.shopId, actor);
  const { s, plan, shop } = row;
  const profile = await getRule("platformTaxProfile");
  let issuedAt: Date | null = null;
  if (s.paymentIntentId) {
    const [pi] = await db.select({ at: paymentIntents.capturedAt }).from(paymentIntents).where(eq(paymentIntents.id, s.paymentIntentId));
    issuedAt = pi?.at ?? null;
  }
  if (!issuedAt) {
    const [ev] = await db.select({ at: healthEvents.createdAt }).from(healthEvents).where(and(eq(healthEvents.name, "prime.subscribed"), eq(healthEvents.subjectId, s.id))).limit(1);
    issuedAt = ev?.at ?? s.createdAt;
  }
  const supplierState = gstState(profile.stateCode)?.alpha ?? null;
  const recipientState = shopStateCode(shop);
  const supplyType: "INTRA" | "INTER" = supplierState && recipientState && supplierState !== recipientState ? "INTER" : "INTRA";
  const taxable = s.pricePaise - s.discountPaise;
  const gst = s.gstPaise;
  const gstRateBp = taxable > 0 ? Math.round((gst * 10_000) / taxable) : (await getRule("health")).primeGstBp;
  const cgst = supplyType === "INTRA" ? Math.floor(gst / 2) : 0;
  const tier = PRIME_TIER_LABELS[s.tier as PrimeTier] ?? s.tier;
  return {
    invoiceNumber: s.invoiceNumber!,
    issuedAt: issuedAt.toISOString(),
    supplier: { legalName: profile.legalName, tradeName: profile.tradeName, gstin: profile.gstin, pan: profile.pan, address: profile.address, stateCode: profile.stateCode, email: profile.email, sac: profile.sacCodes.PLATFORM_FEE },
    recipient: {
      name: shop.name,
      legalName: shop.legalBusinessName ?? shop.name,
      gstin: isValidGstin(shop.gstin) ? shop.gstin : null,
      address: [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode].filter(Boolean).join(", "),
      stateCode: recipientState,
      registrationNumber: shop.registrationNumber,
    },
    supplyType,
    placeOfSupply: recipientState ?? supplierState,
    line: {
      description: `GoKesari Health ${plan.name} (${tier}) listing plan, ${s.term.toLowerCase()}`,
      period: s.startsAt && s.endsAt ? `${fmtDate(s.startsAt)} to ${fmtDate(s.endsAt)}` : "",
      pricePaise: s.pricePaise,
      discountPaise: s.discountPaise,
      couponCode: s.couponCode,
    },
    taxablePaise: taxable,
    gstRateBp,
    cgstPaise: cgst,
    sgstPaise: supplyType === "INTRA" ? gst - cgst : 0,
    igstPaise: supplyType === "INTER" ? gst : 0,
    gstPaise: gst,
    totalPaise: s.totalPaise,
  };
}

export function primeInvoiceLines(inv: PrimeInvoice): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text: text.slice(0, W), bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  const rule = "-".repeat(W);
  add("TAX INVOICE (GoKesari Health Prime)", true);
  pair(`Invoice no: ${inv.invoiceNumber}`, `Date: ${fmtDate(inv.issuedAt)}`);
  add(rule);
  add("SUPPLIER", true);
  add(`${inv.supplier.legalName}${inv.supplier.tradeName ? ` (${inv.supplier.tradeName})` : ""}`);
  add(inv.supplier.address);
  add([`GSTIN: ${inv.supplier.gstin || "-"}`, inv.supplier.pan ? `PAN: ${inv.supplier.pan}` : null, `State: ${stateLabel(inv.supplier.stateCode) ?? inv.supplier.stateCode}`].filter(Boolean).join("   "));
  add();
  add("RECIPIENT", true);
  add(inv.recipient.legalName);
  add(inv.recipient.address);
  add([inv.recipient.gstin ? `GSTIN: ${inv.recipient.gstin}` : "GSTIN: not registered", inv.recipient.stateCode ? `State: ${stateLabel(inv.recipient.stateCode) ?? inv.recipient.stateCode}` : null, `Shop no: ${inv.recipient.registrationNumber}`].filter(Boolean).join("   "));
  add(`Place of supply: ${stateLabel(inv.placeOfSupply) ?? inv.placeOfSupply ?? "-"}   Supply: ${inv.supplyType === "INTRA" ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}   Reverse charge: No`);
  add(rule);
  add(`Service (SAC ${inv.supplier.sac})`, true);
  add(inv.line.description);
  if (inv.line.period) add(`Plan period: ${inv.line.period}`);
  add(rule);
  pair("Plan price", money(inv.line.pricePaise));
  if (inv.line.discountPaise > 0) pair(`Coupon${inv.line.couponCode ? ` ${inv.line.couponCode}` : ""}`, `- ${money(inv.line.discountPaise)}`);
  pair("Taxable value", money(inv.taxablePaise));
  if (inv.supplyType === "INTRA") {
    pair(`CGST ${pct(inv.gstRateBp / 2)}`, money(inv.cgstPaise));
    pair(`SGST ${pct(inv.gstRateBp / 2)}`, money(inv.sgstPaise));
  } else pair(`IGST ${pct(inv.gstRateBp)}`, money(inv.igstPaise));
  pair(`GST ${pct(inv.gstRateBp)} (total tax)`, money(inv.gstPaise));
  pair("Total paid", money(inv.totalPaise));
  add(amountInWords(inv.totalPaise));
  add();
  add("Note: Prime improves how the profile is shown (always labelled) and adds booking, calling and analytics tools.");
  add("It does not guarantee any number of patients, calls or bookings.");
  add();
  add(`For ${inv.supplier.legalName}`);
  add("Authorised signatory (electronically issued)");
  return out;
}

export async function primeInvoicePdf(subscriptionId: string, actor: HealthActor): Promise<{ pdf: Buffer; filename: string; invoice: PrimeInvoice }> {
  const inv = await primeInvoice(subscriptionId, actor);
  const qr = [
    `SellerGSTIN:${inv.supplier.gstin}`,
    `BuyerGSTIN:${inv.recipient.gstin ?? "URP"}`,
    `DocNo:${inv.invoiceNumber}`,
    `DocDt:${inv.issuedAt.slice(0, 10)}`,
    `TotInvVal:${(inv.totalPaise / 100).toFixed(2)}`,
    `TaxableVal:${(inv.taxablePaise / 100).toFixed(2)}`,
    `GST:${(inv.gstPaise / 100).toFixed(2)}`,
    `SAC:${inv.supplier.sac}`,
  ].join("|");
  const pdf = textPdf(primeInvoiceLines(inv), { title: `Invoice ${inv.invoiceNumber}`, qr: { ...qrMatrix(qr), caption: ["Invoice QR code", inv.invoiceNumber, `Value ${money(inv.totalPaise)}`] } });
  return { pdf, filename: `${inv.invoiceNumber.replace(/[^\w-]+/g, "-")}.pdf`, invoice: inv };
}
