/**
 * The draft of a supplier bill the owner reviews (docs/inventory-accounting-2026-10, Part 6):
 * what the reader extracted, field by field with its confidence, the
 * product each line maps to, and the checks run on it. Shared by the
 * extraction engines (server), the review screen (client) and the confirm
 * step, which re-runs `validateDraft` on whatever the owner submits.
 *
 * Amounts are paise; quantities ×1000; GST rates basis points.
 */
import { isValidGstin } from "@/lib/gst-states";

import {
  grossPaise,
  isInterState,
  isStandardGstRate,
  LINE_TOLERANCE_PAISE,
  stateOfGstin,
  taxOnTaxable,
  TOTAL_TOLERANCE_PAISE,
} from "./gst-math";

/** One extracted value and how sure the reader is (0–100). */
export interface DraftField<T> {
  value: T;
  confidence: number;
}

export type MatchMethod = "BARCODE" | "SUPPLIER_MAP" | "HSN_NAME" | "NAME" | "USER" | "NEW";

export interface DraftMatch {
  shopProductId: string | null;
  productName: string | null;
  method: MatchMethod | null;
  score: number;
  suggestions: { shopProductId: string; name: string; score: number }[];
  /** The listing's sellable unit, for the review screen ("500 g", "piece"). */
  sellableUnit?: string | null;
  /** The billed quantity in sellable units ×1000, when the units convert. */
  stockQtyMilli?: number | null;
  conversionProblem?: string | null;
  /** Saved conversion (milli sellable units per 1 billed unit), when the owner set one. */
  milliPerUnit?: number | null;
  /** "Create new product" chosen: created on confirm with these details. */
  createNew?: { name: string; unit: string; hsn: string | null; gstRateBp: number | null; mrpPaise: number | null; sellingPricePaise: number | null } | null;
}

export interface DraftLine {
  id: string;
  description: DraftField<string>;
  hsn: DraftField<string | null>;
  barcode: DraftField<string | null>;
  supplierItemCode?: string | null;
  qtyMilli: DraftField<number | null>;
  unit: DraftField<string | null>;
  ratePaise: DraftField<number | null>;
  discountPaise: DraftField<number | null>;
  gstRateBp: DraftField<number | null>;
  taxablePaise: DraftField<number | null>;
  taxPaise: DraftField<number | null>;
  totalPaise: DraftField<number | null>;
  batchNo: DraftField<string | null>;
  expiryDate: DraftField<string | null>;
  mrpPaise: DraftField<number | null>;
  match: DraftMatch;
}

export interface BillDraft {
  supplierName: DraftField<string | null>;
  supplierGstin: DraftField<string | null>;
  invoiceNo: DraftField<string | null>;
  invoiceDate: DraftField<string | null>;
  placeOfSupply: DraftField<string | null>;
  reverseCharge: boolean;
  irn: string | null;
  totals: {
    taxablePaise: DraftField<number | null>;
    cgstPaise: DraftField<number | null>;
    sgstPaise: DraftField<number | null>;
    igstPaise: DraftField<number | null>;
    cessPaise: DraftField<number | null>;
    otherChargesPaise: DraftField<number | null>;
    roundOffPaise: DraftField<number | null>;
    totalPaise: DraftField<number | null>;
  };
  lines: DraftLine[];
  /** From the signed e-invoice QR: the trusted header the rest is checked against. */
  einvoice?: { irn: string; sellerGstin: string; docNo: string; docDate: string; totalPaise: number; signatureVerified: boolean | null } | null;
  /** The shop's own state code (place of supply defaults to it). */
  buyerStateCode: string | null;
  /** Reader notes for the owner ("handwritten", "page 2 unreadable"). */
  notes: string[];
}

export interface DraftIssue {
  code: string;
  severity: "error" | "warn";
  field?: string;
  line?: number;
  message: string;
}

/** Below this confidence a field is highlighted for checking. */
export const LOW_CONFIDENCE = 70;

export const f = <T>(value: T, confidence = 100): DraftField<T> => ({ value, confidence });

export function emptyLine(id: string): DraftLine {
  return {
    id,
    description: f(""),
    hsn: f(null),
    barcode: f(null),
    qtyMilli: f(null),
    unit: f(null),
    ratePaise: f(null),
    discountPaise: f(0),
    gstRateBp: f(null),
    taxablePaise: f(null),
    taxPaise: f(null),
    totalPaise: f(null),
    batchNo: f(null),
    expiryDate: f(null),
    mrpPaise: f(null),
    match: { shopProductId: null, productName: null, method: null, score: 0, suggestions: [] },
  };
}

export function emptyDraft(buyerStateCode: string | null): BillDraft {
  return {
    supplierName: f(null, 0),
    supplierGstin: f(null, 0),
    invoiceNo: f(null, 0),
    invoiceDate: f(null, 0),
    placeOfSupply: f(buyerStateCode, buyerStateCode ? 60 : 0),
    reverseCharge: false,
    irn: null,
    totals: {
      taxablePaise: f(null, 0),
      cgstPaise: f(null, 0),
      sgstPaise: f(null, 0),
      igstPaise: f(null, 0),
      cessPaise: f(0, 100),
      otherChargesPaise: f(0, 100),
      roundOffPaise: f(null, 0),
      totalPaise: f(null, 0),
    },
    lines: [],
    einvoice: null,
    buyerStateCode,
    notes: [],
  };
}

/** The supplier charges IGST when its state differs from the place of supply. */
export function draftInterState(d: BillDraft): boolean {
  const supplierState = stateOfGstin(d.supplierGstin.value);
  const pos = d.placeOfSupply.value ?? d.buyerStateCode;
  if (supplierState && pos) return isInterState(supplierState, pos);
  // No GSTIN to go by: trust the bill's own heads.
  return (d.totals.igstPaise.value ?? 0) > 0 && !(d.totals.cgstPaise.value ?? 0);
}

export interface ComputedLine {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  totalPaise: number;
}

/**
 * The amounts the books will hold for a line: the printed taxable value when
 * there is one (bills round per line), else qty × rate − discount; tax at the
 * line's rate, split by place of supply.
 */
export function computeLine(line: DraftLine, interState: boolean): ComputedLine {
  const qty = line.qtyMilli.value ?? 0;
  const rate = line.ratePaise.value ?? 0;
  const discount = line.discountPaise.value ?? 0;
  const computedTaxable = grossPaise(qty, rate) - discount;
  const printed = line.taxablePaise.value;
  const taxable = printed ?? computedTaxable;
  const t = taxOnTaxable(taxable, line.gstRateBp.value ?? 0, interState);
  return { taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, cessPaise: t.cessPaise, totalPaise: t.totalPaise };
}

export function computeTotals(d: BillDraft) {
  const inter = draftInterState(d);
  const lines = d.lines.map((l) => computeLine(l, inter));
  const sum = (k: keyof ComputedLine) => lines.reduce((n, l) => n + l[k], 0);
  const other = d.totals.otherChargesPaise.value ?? 0;
  const cess = d.totals.cessPaise.value ?? sum("cessPaise");
  const before = sum("taxablePaise") + sum("cgstPaise") + sum("sgstPaise") + sum("igstPaise") + cess + other;
  const roundOff = d.totals.roundOffPaise.value ?? Math.round(before / 100) * 100 - before;
  return {
    interState: inter,
    lines,
    taxablePaise: sum("taxablePaise"),
    cgstPaise: sum("cgstPaise"),
    sgstPaise: sum("sgstPaise"),
    igstPaise: sum("igstPaise"),
    cessPaise: cess,
    otherChargesPaise: other,
    roundOffPaise: roundOff,
    totalPaise: before + roundOff,
  };
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every check of Part 4: line totals add up to the invoice total, GST maths,
 * supplier GSTIN format, mapping, confidence. The duplicate check needs the
 * database and is added by the server (code DUPLICATE).
 */
export function validateDraft(d: BillDraft, options: { today?: string } = {}): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const today = options.today ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const add = (issue: DraftIssue) => issues.push(issue);

  // Header.
  if (!d.supplierName.value?.trim()) add({ code: "SUPPLIER_NAME", severity: "error", field: "supplierName", message: "Enter the supplier's name." });
  const gstin = d.supplierGstin.value?.replace(/\s+/g, "").toUpperCase() ?? "";
  if (gstin && !isValidGstin(gstin)) {
    add({ code: "GSTIN_FORMAT", severity: "error", field: "supplierGstin", message: "Supplier GSTIN is not valid (15 characters with a matching check digit). Correct it or clear it for an unregistered supplier." });
  }
  if (!gstin) add({ code: "GSTIN_MISSING", severity: "warn", field: "supplierGstin", message: "No supplier GSTIN: no input tax credit can be claimed on this bill." });
  if (!d.invoiceNo.value?.trim()) add({ code: "INVOICE_NO", severity: "error", field: "invoiceNo", message: "Enter the bill / invoice number." });
  else if (d.invoiceNo.value.trim().length > 16 && gstin) add({ code: "INVOICE_NO_LONG", severity: "warn", field: "invoiceNo", message: "GST invoice numbers are at most 16 characters — check the number." });
  if (!d.invoiceDate.value || !isoDate.test(d.invoiceDate.value)) add({ code: "INVOICE_DATE", severity: "error", field: "invoiceDate", message: "Enter the bill date." });
  else if (d.invoiceDate.value > today) add({ code: "INVOICE_DATE_FUTURE", severity: "error", field: "invoiceDate", message: "The bill date is in the future." });

  if (d.einvoice) {
    if (gstin && d.einvoice.sellerGstin !== gstin) add({ code: "EINVOICE_GSTIN", severity: "error", field: "supplierGstin", message: `The e-invoice QR says the supplier GSTIN is ${d.einvoice.sellerGstin}.` });
    if (d.invoiceNo.value && d.einvoice.docNo.toUpperCase() !== d.invoiceNo.value.trim().toUpperCase()) add({ code: "EINVOICE_NO", severity: "error", field: "invoiceNo", message: `The e-invoice QR says the invoice number is ${d.einvoice.docNo}.` });
    if (d.invoiceDate.value && d.einvoice.docDate !== d.invoiceDate.value) add({ code: "EINVOICE_DATE", severity: "error", field: "invoiceDate", message: `The e-invoice QR says the invoice date is ${d.einvoice.docDate}.` });
  }

  // Lines.
  if (d.lines.length === 0) add({ code: "NO_LINES", severity: "error", message: "Add at least one item." });
  const inter = draftInterState(d);
  d.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.description.value.trim()) add({ code: "LINE_DESCRIPTION", severity: "error", line: n, field: "description", message: `Line ${n}: enter the item.` });
    if (!line.qtyMilli.value || line.qtyMilli.value <= 0) add({ code: "LINE_QTY", severity: "error", line: n, field: "qtyMilli", message: `Line ${n}: quantity must be more than 0.` });
    if (line.ratePaise.value == null || line.ratePaise.value < 0) add({ code: "LINE_RATE", severity: "error", line: n, field: "ratePaise", message: `Line ${n}: enter the rate.` });
    const rate = line.gstRateBp.value;
    if (rate == null) add({ code: "LINE_GST_RATE", severity: "error", line: n, field: "gstRateBp", message: `Line ${n}: enter the GST rate (0 if exempt).` });
    else if (!isStandardGstRate(rate)) add({ code: "LINE_GST_RATE_ODD", severity: "warn", line: n, field: "gstRateBp", message: `Line ${n}: ${rate / 100}% is not a usual GST rate.` });
    if (line.qtyMilli.value && line.ratePaise.value != null && line.taxablePaise.value != null) {
      const expected = grossPaise(line.qtyMilli.value, line.ratePaise.value) - (line.discountPaise.value ?? 0);
      if (Math.abs(expected - line.taxablePaise.value) > LINE_TOLERANCE_PAISE) {
        add({ code: "LINE_MATH", severity: "error", line: n, field: "taxablePaise", message: `Line ${n}: quantity × rate − discount is ₹${(expected / 100).toFixed(2)}, the bill says ₹${(line.taxablePaise.value / 100).toFixed(2)}.` });
      }
    }
    if (line.totalPaise.value != null && rate != null) {
      const c = computeLine(line, inter);
      if (Math.abs(c.totalPaise - line.totalPaise.value) > LINE_TOLERANCE_PAISE) {
        add({ code: "LINE_TAX_MATH", severity: "warn", line: n, field: "totalPaise", message: `Line ${n}: with ${rate / 100}% GST the line comes to ₹${(c.totalPaise / 100).toFixed(2)}, the bill says ₹${(line.totalPaise.value / 100).toFixed(2)}.` });
      }
    }
    if (!line.match.shopProductId && !line.match.createNew) add({ code: "LINE_UNMAPPED", severity: "error", line: n, field: "match", message: `Line ${n}: choose the product this is, or "Create new product".` });
    if (line.match.conversionProblem) add({ code: "LINE_UNIT", severity: "error", line: n, field: "unit", message: `Line ${n}: ${line.match.conversionProblem}` });
    if (line.expiryDate.value && line.expiryDate.value < today) add({ code: "LINE_EXPIRED", severity: "warn", line: n, field: "expiryDate", message: `Line ${n}: this batch has already expired.` });
  });

  // Totals.
  const t = computeTotals(d);
  const printed = d.totals;
  const check = (code: string, field: keyof BillDraft["totals"], label: string, computed: number, severity: "error" | "warn") => {
    const v = printed[field].value;
    if (v == null) return;
    if (Math.abs(v - computed) > TOTAL_TOLERANCE_PAISE) {
      add({ code, severity, field: `totals.${field}`, message: `${label}: the items add up to ₹${(computed / 100).toFixed(2)}, the bill says ₹${(v / 100).toFixed(2)}.` });
    }
  };
  check("TOTAL_TAXABLE", "taxablePaise", "Taxable value", t.taxablePaise, "error");
  check("TOTAL_CGST", "cgstPaise", "CGST", t.cgstPaise, "error");
  check("TOTAL_SGST", "sgstPaise", "SGST", t.sgstPaise, "error");
  check("TOTAL_IGST", "igstPaise", "IGST", t.igstPaise, "error");
  check("TOTAL_GRAND", "totalPaise", "Bill total", t.totalPaise, "error");
  if (inter && ((printed.cgstPaise.value ?? 0) > 0 || (printed.sgstPaise.value ?? 0) > 0)) {
    add({ code: "GST_SPLIT", severity: "warn", field: "placeOfSupply", message: "The supplier is in another state, so the bill should charge IGST, not CGST + SGST. Check the place of supply." });
  }
  if (!inter && (printed.igstPaise.value ?? 0) > 0 && !(printed.cgstPaise.value ?? 0)) {
    add({ code: "GST_SPLIT", severity: "warn", field: "placeOfSupply", message: "The supplier is in your state, so the bill should charge CGST + SGST, not IGST. Check the place of supply." });
  }
  if (d.einvoice && Math.abs(d.einvoice.totalPaise - t.totalPaise) > TOTAL_TOLERANCE_PAISE) {
    add({ code: "EINVOICE_TOTAL", severity: "error", field: "totals.totalPaise", message: `The e-invoice QR says the bill total is ₹${(d.einvoice.totalPaise / 100).toFixed(2)}; the items add up to ₹${(t.totalPaise / 100).toFixed(2)}.` });
  }

  // Low confidence (shown in colour; a warning so the owner looks).
  const low: string[] = [];
  const watch: [string, DraftField<unknown>][] = [
    ["supplier name", d.supplierName],
    ["GSTIN", d.supplierGstin],
    ["invoice number", d.invoiceNo],
    ["date", d.invoiceDate],
    ["total", d.totals.totalPaise],
  ];
  for (const [label, field] of watch) if (field.value != null && field.confidence < LOW_CONFIDENCE) low.push(label);
  const lowLines = d.lines.filter((l) => [l.qtyMilli, l.ratePaise, l.gstRateBp, l.taxablePaise].some((x) => x.value != null && x.confidence < LOW_CONFIDENCE)).length;
  if (low.length || lowLines) {
    add({ code: "LOW_CONFIDENCE", severity: "warn", message: `Check the highlighted values${low.length ? ` (${low.join(", ")})` : ""}${lowLines ? `${low.length ? " and" : ""} on ${lowLines} line(s)` : ""} — the reader was not sure of them.` });
  }
  return issues;
}

export const hasErrors = (issues: DraftIssue[]) => issues.some((i) => i.severity === "error");

/* ------------------------------------------------- draft ⇄ purchase input */

/** The purchase the books will hold — the shape of purchaseSchema (src/server/accounts/purchases.ts). */
export interface DraftPurchase {
  supplier: { partyId?: string | null; name: string; gstin: string | null };
  invoiceNo: string;
  invoiceDate: string;
  dueDate?: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  irn: string | null;
  itcEligible?: boolean;
  otherChargesPaise: number;
  roundOffPaise: number | null;
  note?: string | null;
  lines: {
    shopProductId: string | null;
    createNew: { name: string; unit: string; hsn: string | null; gstRateBp: number | null; mrpPaise: number | null; sellingPricePaise: number | null; barcode: string | null } | null;
    description: string;
    hsn: string | null;
    supplierItemCode: string | null;
    qtyMilli: number;
    unit: string | null;
    stockQtyMilli: number | null;
    saveConversionMilliPerUnit: number | null;
    ratePaise: number;
    discountPaise: number;
    taxablePaise: number | null;
    gstRateBp: number;
    batchNo: string | null;
    expiryDate: string | null;
    mrpPaise: number | null;
  }[];
}

/** The reviewed draft as a purchase. */
export function draftToPurchase(d: BillDraft): DraftPurchase {
  const totals = computeTotals(d);
  return {
    supplier: { name: (d.supplierName.value ?? "").trim(), gstin: d.supplierGstin.value?.replace(/\s+/g, "").toUpperCase() || null },
    invoiceNo: (d.invoiceNo.value ?? "").trim(),
    invoiceDate: d.invoiceDate.value ?? "",
    placeOfSupply: d.placeOfSupply.value && /^\d{2}$/.test(d.placeOfSupply.value) ? d.placeOfSupply.value : null,
    reverseCharge: d.reverseCharge,
    irn: d.irn,
    otherChargesPaise: d.totals.otherChargesPaise.value ?? 0,
    roundOffPaise: totals.roundOffPaise,
    lines: d.lines.map((l) => ({
      shopProductId: l.match.createNew ? null : l.match.shopProductId,
      createNew: l.match.createNew ? { ...l.match.createNew, barcode: l.barcode.value } : null,
      description: l.description.value.trim(),
      hsn: l.hsn.value?.replace(/\D/g, "").slice(0, 8) || null,
      supplierItemCode: l.supplierItemCode ?? null,
      qtyMilli: l.qtyMilli.value ?? 0,
      unit: l.unit.value,
      stockQtyMilli: l.match.createNew ? l.qtyMilli.value : (l.match.stockQtyMilli ?? null),
      saveConversionMilliPerUnit: l.match.milliPerUnit && l.unit.value ? l.match.milliPerUnit : null,
      ratePaise: l.ratePaise.value ?? 0,
      discountPaise: l.discountPaise.value ?? 0,
      taxablePaise: l.taxablePaise.value,
      gstRateBp: l.gstRateBp.value ?? 0,
      batchNo: l.batchNo.value,
      expiryDate: l.expiryDate.value,
      mrpPaise: l.mrpPaise.value,
    })),
  };
}

/** A confirmed purchase opened for correction: every value as booked (confidence 100). */
export interface PurchaseLike {
  supplier: { name: string; gstin?: string | null };
  invoiceNo: string;
  invoiceDate: string;
  placeOfSupply?: string | null;
  reverseCharge?: boolean;
  irn?: string | null;
  otherChargesPaise?: number;
  roundOffPaise?: number | null;
  lines: { shopProductId?: string | null; description: string; hsn?: string | null; qtyMilli: number; unit?: string | null; stockQtyMilli?: number | null; ratePaise: number; discountPaise?: number; taxablePaise?: number | null; gstRateBp: number; batchNo?: string | null; expiryDate?: string | null; mrpPaise?: number | null }[];
  totals: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number };
}

export function purchaseToDraft(
  p: PurchaseLike,
  productNames: Record<string, { name: string; sellableUnit: string }>,
  buyerStateCode: string | null,
): BillDraft {
  const d = emptyDraft(buyerStateCode);
  d.supplierName = f(p.supplier.name);
  d.supplierGstin = f(p.supplier.gstin ?? null);
  d.invoiceNo = f(p.invoiceNo);
  d.invoiceDate = f(p.invoiceDate);
  d.placeOfSupply = f(p.placeOfSupply ?? buyerStateCode);
  d.reverseCharge = p.reverseCharge ?? false;
  d.irn = p.irn ?? null;
  d.totals = {
    taxablePaise: f(p.totals.taxablePaise),
    cgstPaise: f(p.totals.cgstPaise),
    sgstPaise: f(p.totals.sgstPaise),
    igstPaise: f(p.totals.igstPaise),
    cessPaise: f(p.totals.cessPaise),
    otherChargesPaise: f(p.otherChargesPaise ?? 0),
    roundOffPaise: f(p.roundOffPaise ?? null),
    totalPaise: f(p.totals.totalPaise),
  };
  d.lines = p.lines.map((l, i) => ({
    ...emptyLine(`line-${i + 1}`),
    description: f(l.description),
    hsn: f(l.hsn ?? null),
    qtyMilli: f(l.qtyMilli),
    unit: f(l.unit ?? null),
    ratePaise: f(l.ratePaise),
    discountPaise: f(l.discountPaise ?? 0),
    gstRateBp: f(l.gstRateBp),
    taxablePaise: f(l.taxablePaise ?? null),
    batchNo: f(l.batchNo ?? null),
    expiryDate: f(l.expiryDate ?? null),
    mrpPaise: f(l.mrpPaise ?? null),
    match: {
      shopProductId: l.shopProductId ?? null,
      productName: l.shopProductId ? (productNames[l.shopProductId]?.name ?? null) : null,
      sellableUnit: l.shopProductId ? (productNames[l.shopProductId]?.sellableUnit ?? null) : null,
      method: "USER",
      score: 1,
      suggestions: [],
      stockQtyMilli: l.stockQtyMilli ?? null,
    },
  }));
  return d;
}
