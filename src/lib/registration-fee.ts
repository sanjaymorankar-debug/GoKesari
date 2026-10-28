/**
 * One-time shop registration fee by declared annual turnover, in three slabs
 * (owner, 28 Oct 2026): slab 1 up to ₹2 crore, slab 2 up to ₹10 crore, slab 3
 * above ₹10 crore. Both limits and the three fees are the admin rule
 * `registrationFeeByTurnover` (src/server/config/rules.ts; Admin → Registration
 * fees → Fee by turnover), so they change without a deploy. GST is added on top
 * (registrationFeeBreakdown below).
 *
 * Pure — shared by the registration form (to show the fee before submit) and
 * the server (which computes the fee it actually charges; a fee sent by the
 * browser is never trusted).
 */

export interface TurnoverFeeRule {
  enabled: boolean;
  /** Turnover up to and including this many rupees is slab 1. */
  slab1UpToRupees: number;
  /** Turnover above slab 1, up to and including this many rupees, is slab 2; above it, slab 3. */
  slab2UpToRupees: number;
  slab1FeePaise: number;
  slab2FeePaise: number;
  slab3FeePaise: number;
}

export type TurnoverSlab = 1 | 2 | 3;

/** The slab a declared annual turnover (whole rupees, zero or more) falls in. */
export function turnoverSlab(turnoverRupees: number, rule: TurnoverFeeRule): TurnoverSlab {
  if (turnoverRupees <= rule.slab1UpToRupees) return 1;
  return turnoverRupees <= rule.slab2UpToRupees ? 2 : 3;
}

/** The fee (before GST) for a declared annual turnover. */
export function feeForTurnover(turnoverRupees: number, rule: TurnoverFeeRule): number {
  const slab = turnoverSlab(turnoverRupees, rule);
  return slab === 1 ? rule.slab1FeePaise : slab === 2 ? rule.slab2FeePaise : rule.slab3FeePaise;
}

/** "Up to ₹2 crore", "₹2 crore – ₹10 crore", "Above ₹10 crore". */
export function turnoverSlabLabel(slab: TurnoverSlab, rule: TurnoverFeeRule): string {
  if (slab === 1) return `Up to ${formatRupeesIndian(rule.slab1UpToRupees)}`;
  if (slab === 2) return `${formatRupeesIndian(rule.slab1UpToRupees)} – ${formatRupeesIndian(rule.slab2UpToRupees)}`;
  return `Above ${formatRupeesIndian(rule.slab2UpToRupees)}`;
}

/** Largest annual turnover accepted on the form: ₹1 lakh crore. */
export const MAX_ANNUAL_TURNOVER_RUPEES = 1_000_000_000_000;

/**
 * Parses what the owner typed into the turnover field: whole rupees, commas and
 * spaces allowed ("1,50,00,000"). Null for anything else.
 */
export function parseTurnoverRupees(raw: string): number | null {
  const cleaned = raw.replace(/[,\s₹]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value > MAX_ANNUAL_TURNOVER_RUPEES) return null;
  return value;
}

/** "₹2 crore", "₹50 lakh", "₹75,000" — how the threshold reads on the form. */
export function formatRupeesIndian(rupees: number): string {
  if (rupees >= 1_00_00_000 && rupees % 1_00_000 === 0) {
    const crore = rupees / 1_00_00_000;
    return `₹${Number.isInteger(crore) ? crore : crore.toFixed(2).replace(/0+$/, "")} crore`;
  }
  if (rupees >= 1_00_000 && rupees % 1_000 === 0) {
    const lakh = rupees / 1_00_000;
    return `₹${Number.isInteger(lakh) ? lakh : lakh.toFixed(2).replace(/0+$/, "")} lakh`;
  }
  return `₹${rupees.toLocaleString("en-IN")}`;
}

/* ------------------------------------------- fee with coupon and GST (27 Oct 2026) */

/**
 * The one-time registration fee as the owner pays it: the base fee, less a
 * coupon, plus GST on what is left. The total is what is charged; GoKesari's
 * fee invoice later reads it as GST-inclusive and splits it back the same way.
 */
export interface RegistrationFeeBreakdown {
  basePaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstRateBp: number;
  gstPaise: number;
  totalPaise: number;
}

/** GST rounded to the paisa, as on GoKesari's fee invoices. */
export function registrationFeeBreakdown(basePaise: number, discountPaise: number, gstRateBp: number): RegistrationFeeBreakdown {
  const discount = Math.max(0, Math.min(discountPaise, basePaise));
  const taxablePaise = basePaise - discount;
  const gstPaise = Math.round((taxablePaise * gstRateBp) / 10_000);
  return { basePaise, discountPaise: discount, taxablePaise, gstRateBp, gstPaise, totalPaise: taxablePaise + gstPaise };
}

export interface RegistrationFeeCouponTerms {
  discountType: "FLAT" | "PERCENT";
  flatPaise: number | null;
  percent: number | null;
  maxDiscountPaise: number | null;
}

/** A coupon's discount on the base fee: never more than the base. */
export function registrationCouponDiscount(coupon: RegistrationFeeCouponTerms, basePaise: number): number {
  const raw =
    coupon.discountType === "FLAT" ? (coupon.flatPaise ?? 0) : Math.floor((basePaise * (coupon.percent ?? 0)) / 100);
  const capped = coupon.maxDiscountPaise != null ? Math.min(raw, coupon.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(capped, basePaise));
}

/** "18%" or "12.5%" from basis points. */
export function formatGstRate(rateBp: number): string {
  return `${rateBp % 100 === 0 ? rateBp / 100 : (rateBp / 100).toFixed(2).replace(/0+$/, "")}%`;
}
