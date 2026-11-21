/**
 * Franchise zones, tiers, fees and coupons — the pure rules of the owner's final brief (21-Nov-2026 08.06 IST, §5).
 * Money in paise, rates in basis points (100 bp = 1%). No database access: the server passes the figures in.
 */
import type { CouponScope, ZoneTier } from "./franchise";

/* ================================================================ tier and fee (§5.2) */

export interface TierSettings {
  /** The standard annual fee (₹1,50,000). */
  standardFeePaise: number;
  /** ±band around the average that is Standard (1000 = 10%); exactly on the band is Standard. */
  standardBandBp: number;
  /** Optional floor and ceiling on a computed fee; null = off (the default). */
  feeMinPaise: number | null;
  feeMaxPaise: number | null;
}

export const DEFAULT_TIER_SETTINGS: TierSettings = { standardFeePaise: 15_000_000, standardBandBp: 1000, feeMinPaise: null, feeMaxPaise: null };

/** The mean of the zone set's values (active zones only — the caller filters). */
export function averageOf(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface TierResult {
  tier: ZoneTier;
  /** zone ÷ average − 1, in basis points (rounded half up). */
  diffBp: number;
  feePaise: number;
}

/**
 * §5.2: difference = value ÷ average − 1. More than +band → Premier, more than −band below → Emerging, otherwise
 * Standard (exactly ±10% is Standard). Premier / Emerging fee = standard fee × (1 + difference), rounded to the
 * nearest ₹1,000; then the optional min / max. Exact arithmetic on integers (value and average scaled by 10⁶) so
 * a +10.0% zone is never mistaken for +10.1%.
 */
export function tierFor(value: number, average: number, s: TierSettings = DEFAULT_TIER_SETTINGS): TierResult {
  if (!(average > 0)) return { tier: "STANDARD", diffBp: 0, feePaise: clampFee(s.standardFeePaise, s) };
  const B = BigInt;
  const v = B(Math.round(value * 1_000_000));
  const a = B(Math.round(average * 1_000_000));
  // diff × 10,000 × a = (v − a) × 10,000; compare against ±band exactly.
  const numerator = (v - a) * B(10_000);
  const band = B(s.standardBandBp) * a;
  const tier: ZoneTier = numerator > band ? "PREMIER" : numerator < -band ? "EMERGING" : "STANDARD";
  const diffBp = Number(roundHalfUp(numerator, a));
  if (tier === "STANDARD") return { tier, diffBp, feePaise: clampFee(s.standardFeePaise, s) };
  // fee = standard × v / a, to the nearest ₹1,000 (100,000 paise), half up.
  const thousands = roundHalfUp(B(s.standardFeePaise) * v, a * B(100_000));
  return { tier, diffBp, feePaise: clampFee(Number(thousands) * 100_000, s) };
}

function roundHalfUp(n: bigint, d: bigint): bigint {
  const zero = BigInt(0);
  const one = BigInt(1);
  const two = BigInt(2);
  if (d < zero) return roundHalfUp(-n, -d);
  const q = n / d;
  const r = n % d;
  if (r === zero) return q;
  if (n >= zero) return two * r >= d ? q + one : q;
  return -two * r > d ? q - one : q;
}

function clampFee(fee: number, s: TierSettings): number {
  let f = fee;
  if (s.feeMinPaise != null) f = Math.max(f, s.feeMinPaise);
  if (s.feeMaxPaise != null) f = Math.min(f, s.feeMaxPaise);
  return f;
}

/* ================================================================ display names and text (§5.2, §5.4) */

/** Allowed display-name pairs per tier; the first is the default. */
export const TIER_NAME_CHOICES: Record<ZoneTier, readonly [string, string]> = {
  PREMIER: ["Premier", "Platinum"],
  STANDARD: ["Standard", "Established"],
  EMERGING: ["Emerging", "Developing"],
};

export const DEFAULT_TIER_COLOURS: Record<ZoneTier, string> = { PREMIER: "#7c3aed", STANDARD: "#0369a1", EMERGING: "#15803d" };

export interface TierDisplay {
  names: Record<ZoneTier, string>;
  colours: Record<ZoneTier, string>;
}

export const DEFAULT_TIER_DISPLAY: TierDisplay = {
  names: { PREMIER: "Premier", STANDARD: "Standard", EMERGING: "Emerging" },
  colours: DEFAULT_TIER_COLOURS,
};

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const rupeesWhole = (paise: number) => `₹${INR.format(Math.round(paise / 100))}`;

/**
 * The zone's one-paragraph description (§5.4), positive for every tier: an Emerging zone is a growth opportunity at a
 * lower entry fee. `setName` is the zone set's city ("Pune").
 */
export function zoneDescription(input: { tier: ZoneTier; diffBp: number; reason: string; feePaise: number; setName: string; display?: TierDisplay }): string {
  const d = input.display ?? DEFAULT_TIER_DISPLAY;
  const pct = Math.round(Math.abs(input.diffBp) / 100);
  const avg = `the ${input.setName} zone average`;
  const fee = `Annual franchise fee ${rupeesWhole(input.feePaise)} + GST.`;
  const reason = input.reason.trim().replace(/\.$/, "");
  if (input.tier === "PREMIER") return `${d.names.PREMIER} zone – business about ${pct}% above ${avg}. ${reason}. ${fee}`;
  if (input.tier === "EMERGING") return `${d.names.EMERGING} zone – business about ${pct}% below ${avg}. ${reason}, with room to grow. ${fee}`;
  const where = pct === 0 ? `in line with ${avg}` : `within ${pct}% of ${avg}`;
  return `${d.names.STANDARD} zone – business ${where}. ${reason}. ${fee}`;
}

/** "+21%" / "−30%" / "0%" from a difference in bp. */
export const vsAverage = (diffBp: number) => (diffBp === 0 ? "0%" : `${diffBp > 0 ? "+" : "−"}${Math.round(Math.abs(diffBp) / 100)}%`);

/* ================================================================ coupons (§5.7) */

export interface CouponTerms {
  discountType: "PERCENT" | "FLAT";
  percentBp: number | null;
  flatPaise: number | null;
  maxDiscountPaise: number | null;
  scope: CouponScope;
}

export interface CartLine {
  zoneId: string;
  zoneSetCode: string;
  tier: ZoneTier;
  listPaise: number;
}

export function inScope(scope: CouponScope, line: Pick<CartLine, "zoneId" | "zoneSetCode" | "tier">): boolean {
  if (scope.all) return true;
  const sets = scope.zoneSets ?? [];
  const tiers = scope.tiers ?? [];
  const zones = scope.zones ?? [];
  if (!sets.length && !tiers.length && !zones.length) return false;
  return (!sets.length || sets.includes(line.zoneSetCode)) && (!tiers.length || tiers.includes(line.tier)) && (!zones.length || zones.includes(line.zoneId));
}

/**
 * The discount on each cart line (before GST). A % coupon applies to each eligible zone's fee; its cap (if any)
 * limits the cart's total discount and is shared in proportion to the fees. A flat coupon is split across the
 * eligible zones in proportion to their fees. No line's fee ever goes below ₹1. Rounding remainders go to the
 * largest line so the parts add up exactly.
 */
export function couponDiscounts(terms: CouponTerms, lines: readonly CartLine[]): number[] {
  const eligible = lines.map((l) => inScope(terms.scope, l));
  const base = lines.map((l, i) => (eligible[i] ? l.listPaise : 0));
  const eligibleTotal = base.reduce((s, v) => s + v, 0);
  if (eligibleTotal <= 0) return lines.map(() => 0);
  const caps = lines.map((l) => Math.max(0, l.listPaise - 100));
  if (terms.discountType === "PERCENT") {
    const raw = base.map((v, i) => Math.min(caps[i], Math.floor((v * (terms.percentBp ?? 0)) / 10_000)));
    const sum = raw.reduce((s, v) => s + v, 0);
    if (terms.maxDiscountPaise == null || sum <= terms.maxDiscountPaise) return raw;
    return splitProportionally(terms.maxDiscountPaise, base, caps);
  }
  return splitProportionally(terms.flatPaise ?? 0, base, caps);
}

/** Splits `amount` over `weights` (proportionally), never above `caps`, remainder to the largest weight. */
export function splitProportionally(amount: number, weights: readonly number[], caps: readonly number[]): number[] {
  const total = weights.reduce((s, v) => s + v, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const capped = Math.min(amount, caps.reduce((s, c, i) => s + (weights[i] > 0 ? c : 0), 0));
  const parts = weights.map((w, i) => Math.min(caps[i], Math.floor((capped * w) / total)));
  let rest = capped - parts.reduce((s, v) => s + v, 0);
  const order = weights.map((w, i) => i).filter((i) => weights[i] > 0).sort((a, b) => weights[b] - weights[a]);
  for (const i of order) {
    if (rest <= 0) break;
    const add = Math.min(rest, caps[i] - parts[i]);
    parts[i] += add;
    rest -= add;
  }
  return parts;
}

/** GST on an amount (bp), rounded half up to the paisa. */
export const gstOn = (paise: number, rateBp: number) => Math.round((paise * rateBp) / 10_000);

/** A coupon code as stored and compared (trimmed, upper case). */
export const normaliseCouponCode = (code: string) => code.trim().toUpperCase();

/* ================================================================ one-time commission cases (§3) */

export type CaseCode = "A1" | "A2" | "A3" | "A4" | "B1" | "B2" | "B3" | "B4";

/** Who registered the shop → the case: 1 the top person, 2 an agent directly under him, 3 an agent under a team lead, 4 a team lead. */
export function caseOf(model: "A" | "B", signer: { role: "AGENT" | "TEAM_LEAD" } | null, hasLead: boolean): CaseCode {
  const n = !signer ? 1 : signer.role === "TEAM_LEAD" ? 4 : hasLead ? 3 : 2;
  return `${model}${n}` as CaseCode;
}

export interface OneTimeRates {
  /** Agent / team-lead direct (shared by both models: the parity rule). */
  memberDirectBp: number;
  /** Team lead's override on his agents' shops (shared by both models). */
  leadOverrideBp: number;
  /** Free dealer: own shop, override one level up, second override two levels up. */
  dealerSelfBp: number;
  dealerOverrideBp: number;
  dealerSecondOverrideBp: number;
  /** Franchise owner: own shop, override on every team shop. */
  ownerSelfBp: number;
  ownerOverrideBp: number;
}

export const DEFAULT_ONE_TIME_RATES: OneTimeRates = { memberDirectBp: 2000, leadOverrideBp: 400, dealerSelfBp: 2000, dealerOverrideBp: 400, dealerSecondOverrideBp: 300, ownerSelfBp: 2500, ownerOverrideBp: 500 };

/** The split of one shop's fee (excl. GST) by case (§3.1, §3.2). Amounts in paise, rounded per person. */
export function oneTimeSplit(caseCode: CaseCode, feePaise: number, r: OneTimeRates = DEFAULT_ONE_TIME_RATES): { direct: number; lead: number; top: number; directBp: number; leadBp: number; topBp: number } {
  const bp = (rate: number) => Math.round((feePaise * rate) / 10_000);
  const b = caseCode.startsWith("B");
  const n = Number(caseCode[1]);
  if (n === 1) {
    const topBp = b ? r.ownerSelfBp : r.dealerSelfBp;
    return { direct: 0, lead: 0, top: bp(topBp), directBp: 0, leadBp: 0, topBp };
  }
  const leadBp = n === 3 ? r.leadOverrideBp : 0;
  const topBp = b ? r.ownerOverrideBp : n === 3 ? r.dealerSecondOverrideBp : r.dealerOverrideBp;
  return { direct: bp(r.memberDirectBp), lead: bp(leadBp), top: bp(topBp), directBp: r.memberDirectBp, leadBp, topBp };
}

/** §3.4: the franchise owner's rates may never be lower than the matching free-dealer rates. */
export function parityProblems(r: OneTimeRates): string[] {
  const out: string[] = [];
  if (r.ownerSelfBp < r.dealerSelfBp) out.push(`The franchise owner's own-shop rate (${r.ownerSelfBp / 100}%) cannot be lower than the free dealer's (${r.dealerSelfBp / 100}%).`);
  if (r.ownerOverrideBp < r.dealerOverrideBp) out.push(`The franchise owner's override (${r.ownerOverrideBp / 100}%) cannot be lower than the free dealer's override (${r.dealerOverrideBp / 100}%).`);
  if (r.ownerOverrideBp < r.dealerSecondOverrideBp) out.push(`The franchise owner's override (${r.ownerOverrideBp / 100}%) cannot be lower than the free dealer's second override (${r.dealerSecondOverrideBp / 100}%).`);
  if (r.memberDirectBp + r.leadOverrideBp + r.ownerOverrideBp > 10_000) out.push("Agent, team lead and owner rates together cannot pass 100% of the fee.");
  return out;
}
