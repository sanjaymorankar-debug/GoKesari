/**
 * One-time shop registration fee by declared annual turnover (owner decision,
 * 26 Oct 2026): turnover up to the threshold (₹2 crore) pays the lower fee
 * (₹999), turnover above it pays the higher one (₹4,999). The threshold and both
 * amounts are the admin rule `registrationFeeByTurnover`
 * (src/server/config/rules.ts), so they change without a deploy.
 *
 * Pure — shared by the registration form (to show the fee before submit) and
 * the server (which computes the fee it actually charges; a fee sent by the
 * browser is never trusted).
 */

export interface TurnoverFeeRule {
  enabled: boolean;
  /** Turnover up to and including this many rupees pays `upToFeePaise`. */
  thresholdRupees: number;
  upToFeePaise: number;
  aboveFeePaise: number;
}

/** Largest annual turnover accepted on the form: ₹1 lakh crore. */
export const MAX_ANNUAL_TURNOVER_RUPEES = 1_000_000_000_000;

/** The fee for a declared annual turnover (whole rupees, zero or more). */
export function feeForTurnover(turnoverRupees: number, rule: TurnoverFeeRule): number {
  return turnoverRupees > rule.thresholdRupees ? rule.aboveFeePaise : rule.upToFeePaise;
}

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
