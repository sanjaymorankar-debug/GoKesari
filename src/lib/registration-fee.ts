/**
 * One-time shop registration fee by declared annual turnover, in slabs (owner,
 * 28 Oct 2026). Started as three (up to ₹2 crore, up to ₹10 crore, above);
 * the admin may add more slabs or remove them (owner, same day). Each slab but
 * the last has an upper limit; the last covers everything above the one before.
 * The slabs and fees are the admin rule `registrationFeeByTurnover`
 * (src/server/config/rules.ts; Admin → Registration fees → Fee by turnover), so
 * they change without a deploy. GST is added on top (registrationFeeBreakdown
 * below).
 *
 * Pure — shared by the registration form (to show the fee before submit) and
 * the server (which computes the fee it actually charges; a fee sent by the
 * browser is never trusted).
 */

export interface TurnoverFeeSlab {
  /** Turnover up to and including this many rupees falls in this slab; null on the last slab ("above"). */
  upToRupees: number | null;
  /** Fee before GST. */
  feePaise: number;
}

export interface TurnoverFeeRule {
  enabled: boolean;
  /** Ordered by limit; every slab but the last has a limit above the one before; the last has none. */
  slabs: TurnoverFeeSlab[];
}

/** Most slabs an admin may set. */
export const MAX_TURNOVER_SLABS = 20;

/** The three slabs the rule started with (owner, 28 Oct 2026). */
export const DEFAULT_TURNOVER_SLABS: TurnoverFeeSlab[] = [
  { upToRupees: 2_00_00_000, feePaise: 99_900 },
  { upToRupees: 10_00_00_000, feePaise: 4_99_900 },
  { upToRupees: null, feePaise: 9_99_900 },
];

const LEGACY_KEYS = ["slab1UpToRupees", "slab2UpToRupees", "slab1FeePaise", "slab2FeePaise", "slab3FeePaise"] as const;

/**
 * Reads a rule value saved before slabs became a list (fields slab1UpToRupees,
 * slab2UpToRupees, slab1FeePaise … slab3FeePaise — whole or partial) into the
 * list form, on top of the three slabs in `value.slabs` (or the defaults). A
 * value without those fields is returned as it is.
 */
export function upgradeLegacyTurnoverRule(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (!LEGACY_KEYS.some((k) => k in v)) return value;
  const base =
    Array.isArray(v.slabs) && v.slabs.length === 3 ? (v.slabs as TurnoverFeeSlab[]) : DEFAULT_TURNOVER_SLABS;
  const slabs = base.map((s) => ({ ...s }));
  if (typeof v.slab1UpToRupees === "number") slabs[0].upToRupees = v.slab1UpToRupees;
  if (typeof v.slab2UpToRupees === "number") slabs[1].upToRupees = v.slab2UpToRupees;
  if (typeof v.slab1FeePaise === "number") slabs[0].feePaise = v.slab1FeePaise;
  if (typeof v.slab2FeePaise === "number") slabs[1].feePaise = v.slab2FeePaise;
  if (typeof v.slab3FeePaise === "number") slabs[2].feePaise = v.slab3FeePaise;
  const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !(LEGACY_KEYS as readonly string[]).includes(k)));
  return { ...rest, slabs };
}

/** Null when the slabs are a valid list; otherwise what is wrong, for the admin. */
export function turnoverSlabsProblem(slabs: TurnoverFeeSlab[]): string | null {
  if (slabs.length === 0) return "Add at least one slab.";
  if (slabs.length > MAX_TURNOVER_SLABS) return `At most ${MAX_TURNOVER_SLABS} slabs.`;
  if (slabs[slabs.length - 1].upToRupees !== null) return "The last slab covers every turnover above the one before; it has no limit.";
  for (let i = 0; i < slabs.length - 1; i++) {
    const limit = slabs[i].upToRupees;
    if (limit === null) return `Slab ${i + 1} needs a turnover limit.`;
    if (i > 0 && limit <= (slabs[i - 1].upToRupees as number)) return `Slab ${i + 1}'s limit must be above slab ${i}'s.`;
  }
  return null;
}

/** The slab (1, 2, …) a declared annual turnover (whole rupees, zero or more) falls in. */
export function turnoverSlab(turnoverRupees: number, rule: TurnoverFeeRule): number {
  const i = rule.slabs.findIndex((s) => s.upToRupees === null || turnoverRupees <= s.upToRupees);
  return (i === -1 ? rule.slabs.length - 1 : i) + 1;
}

/** The fee (before GST) for a declared annual turnover. */
export function feeForTurnover(turnoverRupees: number, rule: TurnoverFeeRule): number {
  return rule.slabs[turnoverSlab(turnoverRupees, rule) - 1].feePaise;
}

/** "Up to ₹2 crore", "₹2 crore – ₹10 crore", "Above ₹10 crore" (one slab only: "Any turnover"). */
export function turnoverSlabLabel(slab: number, rule: TurnoverFeeRule): string {
  const own = rule.slabs[slab - 1]?.upToRupees ?? null;
  const previous = slab > 1 ? (rule.slabs[slab - 2]?.upToRupees ?? null) : null;
  if (previous === null) return own === null ? "Any turnover" : `Up to ${formatRupeesIndian(own)}`;
  if (own === null) return `Above ${formatRupeesIndian(previous)}`;
  return `${formatRupeesIndian(previous)} – ${formatRupeesIndian(own)}`;
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
