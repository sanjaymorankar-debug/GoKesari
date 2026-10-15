/**
 * GST arithmetic for the shop's books (docs/inventory-accounting-2026-10).
 * Integer paise and basis points only: 18% is 1800 bp, ₹70 is 7000.
 *
 * Place of supply decides the split: the same state as the supplier → CGST +
 * SGST (half the rate each); another state → IGST at the full rate. Tax is
 * rounded to the paisa per line and per head (as GST software does), and the
 * invoice total is rounded to the rupee with the difference as round-off.
 */

export interface LineInput {
  /** Quantity ×1000 (2.5 kg → 2500). */
  qtyMilli: number;
  /** Price of one unit before GST. */
  ratePaise: number;
  discountPaise?: number;
  gstRateBp: number;
  cessBp?: number;
}

export interface LineTax {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  taxPaise: number;
  totalPaise: number;
}

/** Rates the GST law actually uses for goods (bp). Others are flagged, not refused. */
export const STANDARD_GST_RATES_BP = [0, 10, 25, 100, 150, 300, 500, 1200, 1800, 2800, 4000] as const;

export function isStandardGstRate(rateBp: number): boolean {
  return (STANDARD_GST_RATES_BP as readonly number[]).includes(rateBp);
}

const roundHalfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** qty × rate, rounded to the paisa (qty is milli). */
export function grossPaise(qtyMilli: number, ratePaise: number): number {
  return roundHalfUp((qtyMilli * ratePaise) / 1000);
}

export function lineTax(input: LineInput, interState: boolean): LineTax {
  const gross = grossPaise(input.qtyMilli, input.ratePaise);
  const discount = input.discountPaise ?? 0;
  const taxable = gross - discount;
  return taxOnTaxable(taxable, input.gstRateBp, interState, input.cessBp ?? 0, { gross, discount });
}

/** Tax on an already-known taxable value. */
export function taxOnTaxable(
  taxablePaise: number,
  gstRateBp: number,
  interState: boolean,
  cessBp = 0,
  extra: { gross?: number; discount?: number } = {},
): LineTax {
  const igst = interState ? roundHalfUp((taxablePaise * gstRateBp) / 10_000) : 0;
  const half = interState ? 0 : roundHalfUp((taxablePaise * gstRateBp) / 20_000);
  const cess = roundHalfUp((taxablePaise * cessBp) / 10_000);
  const tax = igst + half * 2 + cess;
  return {
    grossPaise: extra.gross ?? taxablePaise,
    discountPaise: extra.discount ?? 0,
    taxablePaise,
    cgstPaise: half,
    sgstPaise: half,
    igstPaise: igst,
    cessPaise: cess,
    taxPaise: tax,
    totalPaise: taxablePaise + tax,
  };
}

export interface InvoiceTotals {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
  otherChargesPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/** Sums lines; rounds the grand total to the rupee unless `roundOff` says otherwise. */
export function invoiceTotals(lines: Pick<LineTax, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "cessPaise">[], options: { otherChargesPaise?: number; roundOffPaise?: number } = {}): InvoiceTotals {
  const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "cessPaise") => lines.reduce((n, l) => n + l[k], 0);
  const other = options.otherChargesPaise ?? 0;
  const before = sum("taxablePaise") + sum("cgstPaise") + sum("sgstPaise") + sum("igstPaise") + sum("cessPaise") + other;
  const roundOff = options.roundOffPaise ?? roundHalfUp(before / 100) * 100 - before;
  return {
    taxablePaise: sum("taxablePaise"),
    cgstPaise: sum("cgstPaise"),
    sgstPaise: sum("sgstPaise"),
    igstPaise: sum("igstPaise"),
    cessPaise: sum("cessPaise"),
    otherChargesPaise: other,
    roundOffPaise: roundOff,
    totalPaise: before + roundOff,
  };
}

/** Same state → intra-state. Unknown on either side → intra-state (the common local case). */
export function isInterState(supplierStateCode: string | null | undefined, placeOfSupply: string | null | undefined): boolean {
  const a = (supplierStateCode ?? "").trim().slice(0, 2);
  const b = (placeOfSupply ?? "").trim().slice(0, 2);
  if (!/^\d{2}$/.test(a) || !/^\d{2}$/.test(b)) return false;
  return a !== b;
}

/** "27" from a GSTIN, or null. */
export function stateOfGstin(gstin: string | null | undefined): string | null {
  const s = (gstin ?? "").trim().slice(0, 2);
  return /^\d{2}$/.test(s) ? s : null;
}

/** Financial year label of a date, "2026-27". */
export function financialYear(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Tolerance used when checking printed figures (paise). Bills round each line and the total. */
export const LINE_TOLERANCE_PAISE = 100;
export const TOTAL_TOLERANCE_PAISE = 200;
