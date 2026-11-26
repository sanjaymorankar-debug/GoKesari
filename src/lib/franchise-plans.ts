/**
 * Franchise subscription plans (docs/onboarding-v2-2026-11 §Defaults #4; table franchise_plans, migration 0215).
 * Pure pricing so the cart, the booking and the tests agree on one rule.
 */

export interface PlanPricing {
  pricePerZonePaise: number | null;
  gstExtra: boolean;
  isLaunchOffer: boolean;
}

export interface ZoneFees {
  /** What the zone sells for now (the launch-offer fee while it is open, else the tier fee). */
  feePaise: number | null;
  /** The zone's regular tier fee. */
  regularFeePaise: number | null;
}

/**
 * The fee (before GST) one zone costs on a plan:
 *  - a fixed plan price (price_per_zone_paise set) — the same for every zone;
 *  - no price (null) — the zone's own fee: for a launch-offer plan what the zone sells for now (the launch-offer fee
 *    while it is open), for any other plan the zone's regular tier fee.
 * A plan whose price already includes GST (gst_extra false) is turned into its fee before GST, so GST is still shown
 * and charged on top of the taxable amount (the booking's total then equals the plan price, give or take a paisa).
 * DEFAULT – confirm with Sanjay: a non-launch plan without a price uses the regular tier fee, not the launch fee.
 */
export function planZoneFeePaise(plan: PlanPricing, zone: ZoneFees, gstRateBp: number): number | null {
  const gross = plan.pricePerZonePaise ?? (plan.isLaunchOffer ? zone.feePaise : (zone.regularFeePaise ?? zone.feePaise));
  if (gross == null) return null;
  return plan.gstExtra ? gross : Math.round((gross * 10_000) / (10_000 + gstRateBp));
}

/** "₹1,50,000 + GST per zone · 12 months" or "Zone tier fee + GST · 12 months". */
export function planPriceLabel(plan: PlanPricing & { durationMonths: number }, rupees: (paise: number) => string): string {
  const price = plan.pricePerZonePaise == null ? "Zone tier fee" : rupees(plan.pricePerZonePaise);
  const gst = plan.gstExtra ? " + GST" : " incl. GST";
  return `${price}${gst} per zone · ${plan.durationMonths} month${plan.durationMonths === 1 ? "" : "s"}`;
}
