/**
 * F10.2.5 (GAP-006, D6) — GoKesari's own tax invoices to shops for its fees
 * (batch-2026-10 WS-E).
 *
 * One invoice per shop per payout cycle (issued when the cycle closes —
 * payouts/cycle.ts) for commission, delivery charges, registration fees and
 * billing / inventory management charges, under GoKesari's GSTIN, legal name
 * and address (rule platformTaxProfile). Fees are the taxable value; GST is
 * added at the rate in force for each fee type (statutory PLATFORM_FEE_GST,
 * dated) — except fees already paid directly (registration), whose GST is
 * inside what was paid. CGST + SGST when the shop is in GoKesari's state,
 * else IGST (place of supply = the shop's state: s.12(2) IGST Act). The
 * recipient's GSTIN is printed when the shop has one. The GST that is not
 * already inside a payment is deducted from the shop's payout.
 *
 * Numbering "<prefix>/<yyYY>/<000001>" (e.g. GKP/2627/000001 — at most 16
 * characters), one gapless series per financial year for invoices, credit
 * notes and debit notes, row-locked like the shops' own invoice counters.
 * Credit notes (fees reduced: refunds, reversals) and debit notes (fees
 * under-billed) are issued against an invoice. A monthly GSTR-1-ready export
 * (B2B / B2CS / CDNR / SAC summary / documents) covers GoKesari's own supplies.
 *
 * Rule platformInvoicing (default OFF) is the switch; production stays off
 * until GoKesari's GSTIN, legal details and prefix are entered.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { gstState, isValidGstin, stateLabel } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { PDF_LINE_WIDTH, textPdf, type PdfLine } from "@/lib/pdf";
import { stateForPincode } from "@/lib/pincode-state";
import { qrMatrix } from "@/lib/qr";
import { db, type DbClient } from "@/server/db";
import {
  platformCreditDebitNotes,
  platformInvoiceCounters,
  platformInvoiceLines,
  platformInvoices,
  shops,
  type PlatformCreditDebitNote,
  type PlatformFeeType,
  type PlatformInvoice,
  type PlatformInvoiceLine,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { safeName } from "@/server/documents/email";
import { periodBounds } from "@/server/gst/gstr1";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { amountInWords, financialYearOf } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";
import { istDay, platformFeeGstRateOn, statutoryResolver, type StatutoryResolver } from "@/server/statutory/rates";

interface Actor {
  id: string;
  role: UserRole;
}

export const FEE_LABELS: Record<PlatformFeeType, string> = {
  COMMISSION: "Marketplace commission (facilitation of sales through GoKesari)",
  DELIVERY_CHARGE: "Delivery charges (GoKesari rider deliveries)",
  PLATFORM_FEE: "Platform fee",
  REGISTRATION_FEE: "Shop registration fee",
  BILLING_MANAGEMENT: "Inventory and billing management services",
};

/* --------------------------------------------------------------- profile */

export interface ProfileStatus {
  enabled: boolean;
  ready: boolean;
  missing: string[];
}

/** Whether GoKesari's own invoicing can run: switched on and its GST identity complete. */
export async function platformInvoicingStatus(): Promise<ProfileStatus> {
  const [rule, profile] = await Promise.all([getRule("platformInvoicing"), getRule("platformTaxProfile")]);
  const missing: string[] = [];
  if (!profile.legalName.trim()) missing.push("legal name");
  if (!isValidGstin(profile.gstin)) missing.push("GSTIN");
  if (!profile.address.trim()) missing.push("address");
  if (!gstState(profile.stateCode)) missing.push("state code");
  else if (isValidGstin(profile.gstin) && gstState(profile.gstin)?.alpha !== gstState(profile.stateCode)?.alpha) missing.push("state code matching the GSTIN");
  return { enabled: rule.enabled, ready: rule.enabled && missing.length === 0, missing };
}

/** "GKP/2627/000001": prefix ≤ 4 + FY (4) + 6 digits = at most 16 characters (GST Rule 46). */
export function formatPlatformDocNumber(prefix: string, financialYear: string, sequence: number): string {
  const fy = `${financialYear.slice(2, 4)}${financialYear.slice(5, 7)}`;
  const number = `${prefix}/${fy}/${String(sequence).padStart(6, "0")}`;
  if (number.length > 16) throw validationFailed("Document numbers must be at most 16 characters: shorten the prefix.");
  return number;
}

/** A shop's GST state: from its GSTIN, else its state, else its PIN code. */
export function shopStateCode(shop: Pick<Shop, "gstin" | "state" | "pincode">): string | null {
  return (
    (isValidGstin(shop.gstin) ? gstState(shop.gstin)?.alpha : null) ??
    gstState(shop.state)?.alpha ??
    stateForPincode(shop.pincode) ??
    null
  );
}

async function nextNumber(series: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE", financialYear: string, client: DbClient): Promise<number> {
  const [counter] = await client
    .insert(platformInvoiceCounters)
    .values({ series, financialYear, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [platformInvoiceCounters.series, platformInvoiceCounters.financialYear],
      set: { lastNumber: sql`${platformInvoiceCounters.lastNumber} + 1` },
    })
    .returning();
  return counter.lastNumber;
}

/* ------------------------------------------------------------- tax maths */

export function gstOnTaxable(taxablePaise: number, rateBp: number, supply: "INTRA" | "INTER") {
  const tax = Math.round((taxablePaise * rateBp) / 10_000);
  if (supply === "INTER") return { cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgst = Math.floor(tax / 2);
  return { cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0 };
}

export interface FeeInput {
  feeType: PlatformFeeType;
  description?: string;
  amountPaise: number;
  /** True when the amount already includes GST (a fee the shop paid directly). */
  inclusive: boolean;
  collectedVia: "PAYOUT" | "SHOP_WALLET" | "PAID_DIRECTLY";
}

interface LineCalc {
  feeType: PlatformFeeType;
  description: string;
  sac: string;
  rateBp: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  collectedVia: FeeInput["collectedVia"];
}

async function calcLines(fees: FeeInput[], supply: "INTRA" | "INTER", day: string, resolve: StatutoryResolver): Promise<LineCalc[]> {
  const profile = await getRule("platformTaxProfile");
  const lines: LineCalc[] = [];
  for (const fee of fees) {
    if (fee.amountPaise <= 0) continue;
    const rateBp = await platformFeeGstRateOn(fee.feeType, day, resolve);
    const taxable = fee.inclusive && rateBp > 0 ? Math.round((fee.amountPaise * 10_000) / (10_000 + rateBp)) : fee.amountPaise;
    let tax = gstOnTaxable(taxable, rateBp, supply);
    if (fee.inclusive) {
      // The parts add up exactly to what was paid.
      const gst = fee.amountPaise - taxable;
      tax = supply === "INTER" ? { cgstPaise: 0, sgstPaise: 0, igstPaise: gst } : { cgstPaise: Math.floor(gst / 2), sgstPaise: gst - Math.floor(gst / 2), igstPaise: 0 };
    }
    lines.push({
      feeType: fee.feeType,
      description: fee.description ?? FEE_LABELS[fee.feeType],
      sac: profile.sacCodes[fee.feeType],
      rateBp,
      taxablePaise: taxable,
      ...tax,
      totalPaise: taxable + tax.cgstPaise + tax.sgstPaise + tax.igstPaise,
      collectedVia: fee.collectedVia,
    });
  }
  return lines;
}

/* --------------------------------------------------------------- invoice */

export interface PlatformInvoiceSnapshot {
  invoiceNumber: string;
  financialYear: string;
  issuedAt: string;
  period: string;
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string | null;
  supplier: { legalName: string; tradeName: string; gstin: string; pan: string; address: string; stateCode: string; email: string };
  recipient: { shopId: string; name: string; legalName: string; gstin: string | null; address: string; stateCode: string | null; registrationNumber: string };
  lines: (LineCalc & { lineNo: number })[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number; gstDeductedPaise: number };
  notes: string[];
}

export interface IssuePlatformInvoiceInput {
  shop: Shop;
  cycleId: string | null;
  period: string;
  fees: FeeInput[];
  issuedAt?: Date;
}

/**
 * Issues GoKesari's invoice for one shop's fees (one per shop per cycle —
 * the existing one is returned on a re-run). Null when there is nothing to
 * invoice. The caller checks platformInvoicingStatus().ready.
 */
export async function issuePlatformInvoice(input: IssuePlatformInvoiceInput, client: DbClient = db): Promise<PlatformInvoice | null> {
  if (input.cycleId) {
    const [existing] = await client
      .select()
      .from(platformInvoices)
      .where(and(eq(platformInvoices.shopId, input.shop.id), eq(platformInvoices.cycleId, input.cycleId)));
    if (existing) return existing;
  }
  const profile = await getRule("platformTaxProfile");
  const issuedAt = input.issuedAt ?? new Date();
  const day = istDay(issuedAt);
  const supplierState = gstState(profile.stateCode)?.alpha ?? null;
  const recipientState = shopStateCode(input.shop);
  const supplyType: "INTRA" | "INTER" = supplierState && recipientState && supplierState !== recipientState ? "INTER" : "INTRA";
  const lines = await calcLines(input.fees, supplyType, day, statutoryResolver(client));
  if (lines.length === 0) return null;

  const financialYear = financialYearOf(issuedAt);
  const sequence = await nextNumber("INVOICE", financialYear, client);
  const invoiceNumber = formatPlatformDocNumber(profile.invoicePrefix, financialYear, sequence);
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise") => lines.reduce((s, l) => s + l[k], 0);
  const gstDeductedPaise = lines.filter((l) => l.collectedVia !== "PAID_DIRECTLY").reduce((s, l) => s + l.cgstPaise + l.sgstPaise + l.igstPaise, 0);
  const recipientGstin = isValidGstin(input.shop.gstin) ? input.shop.gstin : null;
  const notes = [
    "Tax invoice for services supplied by GoKesari to the shop. Reverse charge: No.",
    "GST on fees collected through your payout is deducted from the payout of the same cycle; fees already paid include their GST.",
  ];
  if (!recipientState) notes.push("The shop's state is not on record: treated as an intra-state supply.");
  const snapshot: PlatformInvoiceSnapshot = {
    invoiceNumber,
    financialYear,
    issuedAt: issuedAt.toISOString(),
    period: input.period,
    supplyType,
    placeOfSupply: recipientState ?? supplierState,
    supplier: {
      legalName: profile.legalName,
      tradeName: profile.tradeName,
      gstin: profile.gstin,
      pan: profile.pan,
      address: profile.address,
      stateCode: profile.stateCode,
      email: profile.email,
    },
    recipient: {
      shopId: input.shop.id,
      name: input.shop.name,
      legalName: input.shop.legalBusinessName ?? input.shop.name,
      gstin: recipientGstin,
      address: [input.shop.addressLine1, input.shop.addressLine2, input.shop.area, input.shop.city, input.shop.state, input.shop.pincode].filter(Boolean).join(", "),
      stateCode: recipientState,
      registrationNumber: input.shop.registrationNumber,
    },
    lines: lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    totals: { taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), totalPaise: sum("totalPaise"), gstDeductedPaise },
    notes,
  };
  const [invoice] = await client
    .insert(platformInvoices)
    .values({
      shopId: input.shop.id,
      cycleId: input.cycleId,
      invoiceNumber,
      financialYear,
      sequence,
      supplyType,
      recipientGstin,
      placeOfSupply: snapshot.placeOfSupply,
      taxablePaise: snapshot.totals.taxablePaise,
      cgstPaise: snapshot.totals.cgstPaise,
      sgstPaise: snapshot.totals.sgstPaise,
      igstPaise: snapshot.totals.igstPaise,
      totalPaise: snapshot.totals.totalPaise,
      gstDeductedPaise,
      snapshot: snapshot as unknown as Record<string, unknown>,
      issuedAt,
    })
    .returning();
  await client.insert(platformInvoiceLines).values(
    snapshot.lines.map((l) => ({
      invoiceId: invoice.id,
      lineNo: l.lineNo,
      feeType: l.feeType,
      description: l.description,
      sac: l.sac,
      rateBp: l.rateBp,
      taxablePaise: l.taxablePaise,
      cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise,
      igstPaise: l.igstPaise,
      totalPaise: l.totalPaise,
      collectedVia: l.collectedVia,
    })),
  );
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PLATFORM_INVOICE_ISSUED,
      entityType: "platform_invoice",
      entityId: invoice.id,
      newValue: { invoiceNumber, shopId: input.shop.id, cycleId: input.cycleId, totalPaise: invoice.totalPaise, gstDeductedPaise },
    },
    client,
  );
  return invoice;
}

/* ------------------------------------------------------ credit / debit notes */

export interface IssuePlatformNoteInput {
  invoiceId: string;
  kind: "CREDIT" | "DEBIT";
  reason: string;
  /** One note per source, ever (a refund adjustment id, or the admin's request id). */
  sourceRef: string;
  lines: { feeType: PlatformFeeType; taxablePaise: number }[];
  /** Set when a payout cycle already took the note into account. */
  appliedInCycleId?: string | null;
  createdBy?: string | null;
}

export interface PlatformNoteSnapshot {
  noteNumber: string;
  kind: "CREDIT" | "DEBIT";
  financialYear: string;
  issuedAt: string;
  reason: string;
  againstInvoice: { id: string; number: string; issuedAt: string };
  supplyType: "INTRA" | "INTER";
  placeOfSupply: string | null;
  supplier: PlatformInvoiceSnapshot["supplier"];
  recipient: PlatformInvoiceSnapshot["recipient"];
  lines: { feeType: PlatformFeeType; description: string; sac: string; rateBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number };
}

/**
 * A credit note (fees reduced) or debit note (fees under-billed) against a
 * platform invoice, at the invoice's own rates. A credit note never takes
 * the invoice below zero. Idempotent by sourceRef.
 */
export async function issuePlatformNote(input: IssuePlatformNoteInput, client: DbClient = db): Promise<PlatformCreditDebitNote | null> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Give a reason for the note.");
  const [existing] = await client.select().from(platformCreditDebitNotes).where(eq(platformCreditDebitNotes.sourceRef, input.sourceRef));
  if (existing) return existing;
  const [invoice] = await client.select().from(platformInvoices).where(eq(platformInvoices.id, input.invoiceId)).for("update");
  if (!invoice) throw notFound("Platform invoice");
  const inv = invoice.snapshot as unknown as PlatformInvoiceSnapshot;
  const profile = await getRule("platformTaxProfile");

  const lines: PlatformNoteSnapshot["lines"] = [];
  for (const wanted of input.lines) {
    if (!Number.isInteger(wanted.taxablePaise) || wanted.taxablePaise <= 0) continue;
    const ref = inv.lines.find((l) => l.feeType === wanted.feeType);
    const rateBp = ref?.rateBp ?? (await platformFeeGstRateOn(wanted.feeType, istDay(invoice.issuedAt), statutoryResolver(client)));
    const tax = gstOnTaxable(wanted.taxablePaise, rateBp, invoice.supplyType);
    lines.push({
      feeType: wanted.feeType,
      description: ref?.description ?? FEE_LABELS[wanted.feeType],
      sac: ref?.sac ?? profile.sacCodes[wanted.feeType],
      rateBp,
      taxablePaise: wanted.taxablePaise,
      ...tax,
      totalPaise: wanted.taxablePaise + tax.cgstPaise + tax.sgstPaise + tax.igstPaise,
    });
  }
  if (lines.length === 0) return null;
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise") => lines.reduce((s, l) => s + l[k], 0);
  if (input.kind === "CREDIT") {
    const [{ credited }] = await client
      .select({ credited: sql<number>`coalesce(sum(${platformCreditDebitNotes.totalPaise}) filter (where ${platformCreditDebitNotes.kind} = 'CREDIT'), 0)::bigint` })
      .from(platformCreditDebitNotes)
      .where(eq(platformCreditDebitNotes.invoiceId, invoice.id));
    if (Number(credited) + sum("totalPaise") > invoice.totalPaise) {
      throw conflict("A credit note cannot take the invoice below zero.");
    }
  }
  const issuedAt = new Date();
  const financialYear = financialYearOf(issuedAt);
  const sequence = await nextNumber(input.kind === "CREDIT" ? "CREDIT_NOTE" : "DEBIT_NOTE", financialYear, client);
  const noteNumber = formatPlatformDocNumber(input.kind === "CREDIT" ? profile.creditNotePrefix : profile.debitNotePrefix, financialYear, sequence);
  const snapshot: PlatformNoteSnapshot = {
    noteNumber,
    kind: input.kind,
    financialYear,
    issuedAt: issuedAt.toISOString(),
    reason,
    againstInvoice: { id: invoice.id, number: invoice.invoiceNumber, issuedAt: invoice.issuedAt.toISOString() },
    supplyType: invoice.supplyType,
    placeOfSupply: invoice.placeOfSupply,
    supplier: inv.supplier,
    recipient: inv.recipient,
    lines,
    totals: { taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), totalPaise: sum("totalPaise") },
  };
  const [note] = await client
    .insert(platformCreditDebitNotes)
    .values({
      invoiceId: invoice.id,
      shopId: invoice.shopId,
      kind: input.kind,
      noteNumber,
      financialYear,
      sequence,
      reason,
      sourceRef: input.sourceRef,
      taxablePaise: snapshot.totals.taxablePaise,
      cgstPaise: snapshot.totals.cgstPaise,
      sgstPaise: snapshot.totals.sgstPaise,
      igstPaise: snapshot.totals.igstPaise,
      totalPaise: snapshot.totals.totalPaise,
      appliedInCycleId: input.appliedInCycleId ?? null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      createdBy: input.createdBy ?? null,
      issuedAt,
    })
    .returning();
  await recordAudit(
    {
      actorId: input.createdBy ?? null,
      action: AUDIT_ACTIONS.PLATFORM_NOTE_ISSUED,
      entityType: "platform_invoice",
      entityId: invoice.id,
      newValue: { noteNumber, kind: input.kind, totalPaise: note.totalPaise, reason, sourceRef: input.sourceRef },
    },
    client,
  );
  return note;
}

/** Admin: a credit or debit note by hand; it is settled through the shop's next payout cycle. */
export async function issuePlatformNoteByAdmin(
  input: { invoiceId: string; kind: "CREDIT" | "DEBIT"; reason: string; feeType: PlatformFeeType; taxablePaise: number; requestId: string },
  actor: Actor,
): Promise<PlatformCreditDebitNote> {
  if (!(await getRule("platformInvoicing")).enabled) throw conflict("GoKesari's own invoicing is switched off (rule platformInvoicing).");
  const note = await db.transaction((tx) =>
    issuePlatformNote(
      {
        invoiceId: input.invoiceId,
        kind: input.kind,
        reason: input.reason,
        sourceRef: `admin:${input.requestId}`,
        lines: [{ feeType: input.feeType, taxablePaise: input.taxablePaise }],
        createdBy: actor.id,
      },
      tx,
    ),
  );
  if (!note) throw validationFailed("Enter a taxable amount above zero.");
  return note;
}

/* ------------------------------------------------------------------ reads */

export async function listPlatformInvoices(options: { shopId?: string; limit?: number } = {}) {
  return db
    .select({ invoice: platformInvoices, shopName: shops.name })
    .from(platformInvoices)
    .innerJoin(shops, eq(shops.id, platformInvoices.shopId))
    .where(options.shopId ? eq(platformInvoices.shopId, options.shopId) : undefined)
    .orderBy(desc(platformInvoices.issuedAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

export async function listPlatformNotes(options: { shopId?: string; limit?: number } = {}): Promise<PlatformCreditDebitNote[]> {
  return db
    .select()
    .from(platformCreditDebitNotes)
    .where(options.shopId ? eq(platformCreditDebitNotes.shopId, options.shopId) : undefined)
    .orderBy(desc(platformCreditDebitNotes.issuedAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

export async function getPlatformInvoice(id: string): Promise<{ invoice: PlatformInvoice; lines: PlatformInvoiceLine[] } | null> {
  const [invoice] = await db.select().from(platformInvoices).where(eq(platformInvoices.id, id));
  if (!invoice) return null;
  const lines = await db.select().from(platformInvoiceLines).where(eq(platformInvoiceLines.invoiceId, id)).orderBy(asc(platformInvoiceLines.lineNo));
  return { invoice, lines };
}

/** The shop's owner, and finance (PLATFORM_INVOICE_MANAGE), may see a platform invoice or note. */
export async function canViewPlatformDocument(shopId: string, user: { id: string; role: UserRole }): Promise<boolean> {
  const { can, PERMISSIONS } = await import("@/server/authz/permissions");
  if (can(user.role, PERMISSIONS.PLATFORM_INVOICE_MANAGE) || can(user.role, PERMISSIONS.PAYOUT_VIEW)) return true;
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  return shop?.ownerId === user.id;
}

/* -------------------------------------------------------------------- PDF */

const money = (paise: number) => formatPaise(paise).replace("₹", "Rs. ");
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

function partyLines(add: (t?: string, b?: boolean) => void, title: string, p: { legalName: string; address: string; gstin: string | null; stateCode: string | null }, extra: string[] = []) {
  add(title, true);
  add(p.legalName.slice(0, PDF_LINE_WIDTH));
  add(p.address.slice(0, PDF_LINE_WIDTH));
  add([p.gstin ? `GSTIN: ${p.gstin}` : "GSTIN: not registered", p.stateCode ? `State: ${stateLabel(p.stateCode) ?? p.stateCode}` : null, ...extra].filter(Boolean).join("   "));
}

function documentLines(
  heading: string,
  head: [string, string][],
  s: { supplier: PlatformInvoiceSnapshot["supplier"]; recipient: PlatformInvoiceSnapshot["recipient"]; supplyType: "INTRA" | "INTER"; placeOfSupply: string | null },
  lines: { description: string; sac: string; rateBp: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }[],
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number },
  notes: string[],
): PdfLine[] {
  const W = PDF_LINE_WIDTH;
  const out: PdfLine[] = [];
  const add = (text = "", bold = false) => out.push({ text, bold });
  const pair = (l: string, r: string) => add(l + r.padStart(Math.max(1, W - l.length)));
  const rule = "-".repeat(W);
  add(heading, true);
  for (const [l, r] of head) pair(l, r);
  add(rule);
  partyLines(add, "SUPPLIER", { legalName: `${s.supplier.legalName}${s.supplier.tradeName ? ` (${s.supplier.tradeName})` : ""}`, address: s.supplier.address, gstin: s.supplier.gstin, stateCode: s.supplier.stateCode }, s.supplier.pan ? [`PAN: ${s.supplier.pan}`] : []);
  add();
  partyLines(add, "RECIPIENT (SHOP)", { legalName: s.recipient.legalName, address: s.recipient.address, gstin: s.recipient.gstin, stateCode: s.recipient.stateCode }, [`Shop no: ${s.recipient.registrationNumber}`]);
  add(`Place of supply: ${stateLabel(s.placeOfSupply) ?? s.placeOfSupply ?? "-"}   Supply: ${s.supplyType === "INTRA" ? "Intra-state (CGST + SGST)" : "Inter-state (IGST)"}   Reverse charge: No`);
  add(rule);
  const intra = s.supplyType === "INTRA";
  add(`${"#".padEnd(3)}${"Service".padEnd(38)}${"SAC".padEnd(8)}${"GST".padStart(6)}${"Taxable".padStart(13)}${(intra ? "CGST+SGST" : "IGST").padStart(12)}${"Total".padStart(13)}`.slice(0, W), true);
  lines.forEach((l, i) => {
    const tax = l.cgstPaise + l.sgstPaise + l.igstPaise;
    add(`${String(i + 1).padEnd(3)}${l.description.slice(0, 37).padEnd(38)}${l.sac.padEnd(8)}${pct(l.rateBp).padStart(6)}${money(l.taxablePaise).padStart(13)}${money(tax).padStart(12)}${money(l.totalPaise).padStart(13)}`.slice(0, W));
  });
  add(rule);
  pair("Taxable value", money(totals.taxablePaise));
  if (intra) {
    pair("CGST", money(totals.cgstPaise));
    pair("SGST", money(totals.sgstPaise));
  } else pair("IGST", money(totals.igstPaise));
  pair("Total", money(totals.totalPaise));
  add(amountInWords(totals.totalPaise));
  add();
  for (const n of notes) add(`Note: ${n}`.slice(0, W));
  add();
  add(`For ${s.supplier.legalName}`);
  add("Authorised signatory (electronically issued)");
  return out;
}

export function platformInvoiceQrPayload(s: PlatformInvoiceSnapshot): string {
  return [
    `SellerGSTIN:${s.supplier.gstin}`,
    `BuyerGSTIN:${s.recipient.gstin ?? "URP"}`,
    `DocNo:${s.invoiceNumber}`,
    `DocDt:${s.issuedAt.slice(0, 10)}`,
    `TotInvVal:${(s.totals.totalPaise / 100).toFixed(2)}`,
    `TaxableVal:${(s.totals.taxablePaise / 100).toFixed(2)}`,
    `CGST:${(s.totals.cgstPaise / 100).toFixed(2)}`,
    `SGST:${(s.totals.sgstPaise / 100).toFixed(2)}`,
    `IGST:${(s.totals.igstPaise / 100).toFixed(2)}`,
    `SAC:${[...new Set(s.lines.map((l) => l.sac))].join(",")}`,
  ].join("|");
}

export function renderPlatformInvoicePdf(invoice: PlatformInvoice): Buffer {
  const s = invoice.snapshot as unknown as PlatformInvoiceSnapshot;
  const lines = documentLines(
    "TAX INVOICE (GoKesari fees)",
    [
      [`Invoice no: ${s.invoiceNumber}`, `Date: ${fmtDate(s.issuedAt)}`],
      [`Period: ${s.period}`, `FY ${s.financialYear}`],
    ],
    s,
    s.lines,
    s.totals,
    [...s.notes, `GST deducted from the payout: ${money(s.totals.gstDeductedPaise)}.`],
  );
  return textPdf(lines, { title: `Invoice ${s.invoiceNumber}`, qr: { ...qrMatrix(platformInvoiceQrPayload(s)), caption: ["Invoice QR code", s.invoiceNumber, `Value ${money(s.totals.totalPaise)}`] } });
}

export function renderPlatformNotePdf(note: PlatformCreditDebitNote): Buffer {
  const s = note.snapshot as unknown as PlatformNoteSnapshot;
  const lines = documentLines(
    s.kind === "CREDIT" ? "CREDIT NOTE (GoKesari fees)" : "DEBIT NOTE (GoKesari fees)",
    [
      [`Note no: ${s.noteNumber}`, `Date: ${fmtDate(s.issuedAt)}`],
      [`Against invoice: ${s.againstInvoice.number}`, `Invoice date: ${fmtDate(s.againstInvoice.issuedAt)}`],
    ],
    s,
    s.lines,
    s.totals,
    [`Reason: ${s.reason}`],
  );
  return textPdf(lines, { title: `${s.kind === "CREDIT" ? "Credit" : "Debit"} note ${s.noteNumber}` });
}

export async function renderPlatformInvoiceById(id: string): Promise<{ pdf: Buffer; filename: string; shopId: string } | null> {
  const [invoice] = await db.select().from(platformInvoices).where(eq(platformInvoices.id, id));
  if (!invoice) return null;
  return { pdf: renderPlatformInvoicePdf(invoice), filename: `${safeName(invoice.invoiceNumber)}.pdf`, shopId: invoice.shopId };
}

/* ------------------------------------------------- monthly GSTR-1 summary */

const r2 = (paise: number) => Math.round(paise) / 100;
const dmy = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return `${ist.slice(8, 10)}-${ist.slice(5, 7)}-${ist.slice(0, 4)}`;
};

export interface PlatformGstr1 {
  json: Record<string, unknown>;
  csv: string;
  counts: { b2b: number; b2cs: number; cdnr: number; invoices: number; notes: number };
  checksum: string;
}

/**
 * GoKesari's own supplies for one month, GSTR-1-ready: B2B (recipient
 * GSTIN), B2CS (unregistered shops, by place of supply and rate; their notes
 * netted in), CDNR (notes to registered shops), the SAC summary and the
 * document series issued. Download only — GoKesari's CA files the return.
 */
export async function buildPlatformGstr1(period: string): Promise<PlatformGstr1> {
  const { from, to, fp } = periodBounds(period);
  const profile = await getRule("platformTaxProfile");
  const invoices = await db
    .select()
    .from(platformInvoices)
    .where(and(gte(platformInvoices.issuedAt, from), lt(platformInvoices.issuedAt, to)))
    .orderBy(asc(platformInvoices.financialYear), asc(platformInvoices.sequence));
  const notes = await db
    .select()
    .from(platformCreditDebitNotes)
    .where(and(gte(platformCreditDebitNotes.issuedAt, from), lt(platformCreditDebitNotes.issuedAt, to)))
    .orderBy(asc(platformCreditDebitNotes.issuedAt));
  const invoiceIds = [...new Set(notes.map((n) => n.invoiceId))];
  const against = new Map(
    invoiceIds.length ? (await db.select().from(platformInvoices).where(inArray(platformInvoices.id, invoiceIds))).map((i) => [i.id, i]) : [],
  );

  type Bucket = { txval: number; iamt: number; camt: number; samt: number };
  const itms = (lines: { rateBp: number; taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }[], sign = 1) => {
    const map = new Map<number, Bucket>();
    for (const l of lines) {
      const b = map.get(l.rateBp) ?? { txval: 0, iamt: 0, camt: 0, samt: 0 };
      b.txval += sign * l.taxablePaise;
      b.iamt += sign * l.igstPaise;
      b.camt += sign * l.cgstPaise;
      b.samt += sign * l.sgstPaise;
      map.set(l.rateBp, b);
    }
    return [...map.entries()].map(([rate, b], i) => ({ num: i + 1, itm_det: { txval: r2(b.txval), rt: rate / 100, iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt), csamt: 0 } }));
  };
  const pos = (code: string | null) => gstState(code)?.code ?? gstState(profile.stateCode)?.code ?? "";

  const csvRows: (string | number)[][] = [["section", "recipient_gstin", "number", "date", "note_type", "place_of_supply", "supply_type", "rate_pct", "taxable", "igst", "cgst", "sgst", "total"]];
  const b2bMap = new Map<string, { ctin: string; inv: unknown[] }>();
  const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const sacMap = new Map<string, { hsn_sc: string; rt: number; txval: number; iamt: number; camt: number; samt: number }>();
  const addB2cs = (supply: string, posCode: string, rateBp: number, l: Bucket, sign: number) => {
    const key = `${posCode}|${rateBp}|${supply}`;
    const b = b2cs.get(key) ?? { sply_ty: supply === "INTER" ? "INTER" : "INTRA", pos: posCode, typ: "OE", rt: rateBp / 100, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    b.txval += sign * l.txval;
    b.iamt += sign * l.iamt;
    b.camt += sign * l.camt;
    b.samt += sign * l.samt;
    b2cs.set(key, b);
  };
  const addSac = (sac: string, rateBp: number, l: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number }, sign: number) => {
    const key = `${sac}|${rateBp}`;
    const b = sacMap.get(key) ?? { hsn_sc: sac, rt: rateBp / 100, txval: 0, iamt: 0, camt: 0, samt: 0 };
    b.txval += sign * l.taxablePaise;
    b.iamt += sign * l.igstPaise;
    b.camt += sign * l.cgstPaise;
    b.samt += sign * l.sgstPaise;
    sacMap.set(key, b);
  };

  for (const inv of invoices) {
    const s = inv.snapshot as unknown as PlatformInvoiceSnapshot;
    const posCode = pos(inv.placeOfSupply);
    for (const l of s.lines) {
      addSac(l.sac, l.rateBp, l, 1);
      csvRows.push([inv.recipientGstin ? "B2B" : "B2CS", inv.recipientGstin ?? "", inv.invoiceNumber, dmy(inv.issuedAt), "", posCode, inv.supplyType, l.rateBp / 100, r2(l.taxablePaise), r2(l.igstPaise), r2(l.cgstPaise), r2(l.sgstPaise), r2(l.totalPaise)]);
    }
    if (inv.recipientGstin) {
      const entry = b2bMap.get(inv.recipientGstin) ?? { ctin: inv.recipientGstin, inv: [] };
      entry.inv.push({ inum: inv.invoiceNumber, idt: dmy(inv.issuedAt), val: r2(inv.totalPaise), pos: posCode, rchrg: "N", inv_typ: "R", itms: itms(s.lines) });
      b2bMap.set(inv.recipientGstin, entry);
    } else {
      for (const it of itms(s.lines)) {
        addB2cs(inv.supplyType, posCode, Math.round(it.itm_det.rt * 100), { txval: it.itm_det.txval * 100, iamt: it.itm_det.iamt * 100, camt: it.itm_det.camt * 100, samt: it.itm_det.samt * 100 }, 1);
      }
    }
  }
  const cdnrMap = new Map<string, { ctin: string; nt: unknown[] }>();
  for (const note of notes) {
    const s = note.snapshot as unknown as PlatformNoteSnapshot;
    const inv = against.get(note.invoiceId);
    const posCode = pos(inv?.placeOfSupply ?? null);
    const sign = note.kind === "CREDIT" ? -1 : 1;
    for (const l of s.lines) {
      addSac(l.sac, l.rateBp, l, sign);
      csvRows.push([inv?.recipientGstin ? "CDNR" : "B2CS", inv?.recipientGstin ?? "", note.noteNumber, dmy(note.issuedAt), note.kind === "CREDIT" ? "C" : "D", posCode, s.supplyType, l.rateBp / 100, r2(sign * l.taxablePaise), r2(sign * l.igstPaise), r2(sign * l.cgstPaise), r2(sign * l.sgstPaise), r2(sign * l.totalPaise)]);
    }
    if (inv?.recipientGstin) {
      const entry = cdnrMap.get(inv.recipientGstin) ?? { ctin: inv.recipientGstin, nt: [] };
      entry.nt.push({ ntty: note.kind === "CREDIT" ? "C" : "D", nt_num: note.noteNumber, nt_dt: dmy(note.issuedAt), val: r2(note.totalPaise), pos: posCode, rchrg: "N", inv_typ: "R", itms: itms(s.lines) });
      cdnrMap.set(inv.recipientGstin, entry);
    } else {
      for (const it of itms(s.lines)) {
        addB2cs(s.supplyType, posCode, Math.round(it.itm_det.rt * 100), { txval: it.itm_det.txval * 100, iamt: it.itm_det.iamt * 100, camt: it.itm_det.camt * 100, samt: it.itm_det.samt * 100 }, sign);
      }
    }
  }
  const series = (prefix: string, numbers: string[], natureNum: number, label: string) =>
    numbers.length ? [{ doc_num: natureNum, doc_typ: label, docs: [{ num: 1, from: numbers[0], to: numbers[numbers.length - 1], totnum: numbers.length, cancel: 0, net_issue: numbers.length }] }] : [];
  const json = {
    gstin: profile.gstin,
    fp,
    b2b: [...b2bMap.values()],
    b2cs: [...b2cs.values()].map((b) => ({ ...b, txval: r2(b.txval), iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt) })),
    cdnr: [...cdnrMap.values()],
    hsn: { data: [...sacMap.values()].map((b, i) => ({ num: i + 1, hsn_sc: b.hsn_sc, desc: "Services", uqc: "NA", qty: 0, rt: b.rt, txval: r2(b.txval), iamt: r2(b.iamt), camt: r2(b.camt), samt: r2(b.samt), csamt: 0 })) },
    doc_issue: {
      doc_det: [
        ...series(profile.invoicePrefix, invoices.map((i) => i.invoiceNumber), 1, "Invoices for outward supply"),
        ...series(profile.debitNotePrefix, notes.filter((n) => n.kind === "DEBIT").map((n) => n.noteNumber), 4, "Debit Note"),
        ...series(profile.creditNotePrefix, notes.filter((n) => n.kind === "CREDIT").map((n) => n.noteNumber), 5, "Credit Note"),
      ],
    },
  };
  const csv = csvRows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  const checksum = createHash("sha256").update(JSON.stringify(json)).digest("hex");
  return {
    json,
    csv,
    counts: { b2b: invoices.filter((i) => i.recipientGstin).length, b2cs: invoices.filter((i) => !i.recipientGstin).length, cdnr: notes.filter((n) => against.get(n.invoiceId)?.recipientGstin).length, invoices: invoices.length, notes: notes.length },
    checksum,
  };
}

export function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
