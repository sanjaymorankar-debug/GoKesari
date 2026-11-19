/**
 * Territory dealers (owner, 20-Nov-2026; docs/dealer-programme/TERRITORY_DEALER.md).
 *
 * A TIERED dealer can hold an exclusive territory — a set of pincodes no other
 * dealer may hold — for a yearly fee. He keeps the TIERED registration
 * commission of his team (20% / 4% / 3%) and also earns a share of GoKesari's
 * commission on every order delivered by a shop in his territory: 20% of it at
 * a performance rating of 5, +1% a rating point, at most 25% at rating 10.
 *
 * The rating has two halves of 2.5 points each above the base 5:
 *   shop onboarding — the dealer's own rating (activated-shop slabs) above 5, halved;
 *   product-upload support — the share of approved shops in the territory with
 *   enough active products, times 2.5.
 * Pure helpers here; the server side is src/server/dealers/territory.ts.
 */

export const TERRITORY_STATUSES = ["AWAITING_FEE", "ACTIVE", "EXPIRED", "CANCELLED"] as const;
export type TerritoryStatus = (typeof TERRITORY_STATUSES)[number];

export const TERRITORY_STATUS_LABELS: Record<TerritoryStatus, string> = {
  AWAITING_FEE: "Waiting for the fee",
  ACTIVE: "Active",
  EXPIRED: "Expired — fee not renewed",
  CANCELLED: "Cancelled",
};

export const TERRITORY_FEE_STATUSES = ["AWAITING_PAYMENT", "PAID", "CANCELLED"] as const;
export type TerritoryFeeStatus = (typeof TERRITORY_FEE_STATUSES)[number];

export const TERRITORY_FEE_METHODS = ["ONLINE", "OFFLINE"] as const;
export type TerritoryFeeMethod = (typeof TERRITORY_FEE_METHODS)[number];

/** A 6-digit Indian pincode (no leading 0). */
export const PINCODE = /^[1-9][0-9]{5}$/;

/** Splits "411001, 411002\n411003" into unique, valid pincodes; the bad ones come back separately. */
export function parsePincodes(raw: string): { pincodes: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pincodes = [...new Set(parts.filter((p) => PINCODE.test(p)))].sort();
  const invalid = [...new Set(parts.filter((p) => !PINCODE.test(p)))];
  return { pincodes, invalid };
}

export interface TerritoryRatingInput {
  /** The dealer's own rating (activated-shop slabs), 0–10. */
  onboardingRating: number;
  /** Approved shops in the territory. */
  shopsTotal: number;
  /** Of those, the shops with at least the minimum of active products. */
  shopsLive: number;
  /** How much of the 5 points above the base comes from product upload, in bp (5000 = half). */
  productWeightBp: number;
}

export interface TerritoryRating {
  onboardingPoints: number;
  productPoints: number;
  /** 5.0–10.0, one decimal. */
  rating: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The territory performance rating: 5 + onboarding points + product-upload points, at most 10. */
export function territoryRating(input: TerritoryRatingInput): TerritoryRating {
  const productShare = Math.min(1, Math.max(0, input.productWeightBp / 10_000));
  const onboardingMax = 5 * (1 - productShare);
  const productMax = 5 * productShare;
  const onboarding = Math.min(10, Math.max(5, Number(input.onboardingRating) || 0));
  const onboardingPoints = round1(((onboarding - 5) / 5) * onboardingMax);
  const live = input.shopsTotal > 0 ? Math.min(1, Math.max(0, input.shopsLive / input.shopsTotal)) : 0;
  const productPoints = round1(live * productMax);
  return { onboardingPoints, productPoints, rating: Math.min(10, round1(5 + onboardingPoints + productPoints)) };
}

/** The share of GoKesari's commission at `rating`: baseBp at 5, + stepBp a point, never above maxBp. */
export function territoryShareBp(rating: number, rule: { baseShareBp: number; stepBp: number; maxShareBp: number }): number {
  const above = Math.max(0, Math.min(10, rating) - 5);
  return Math.min(rule.maxShareBp, Math.max(rule.baseShareBp, Math.round(rule.baseShareBp + rule.stepBp * above)));
}

/** GoKesari's commission on refunded goods (the same rounding as the order's commission). */
export function commissionOnPaise(goodsPaise: number, rateBp: number): number {
  return Math.round((Math.max(0, goodsPaise) * rateBp) / 10_000);
}

/** The territory dealer's part of one order: share of the commission GoKesari kept on it. */
export function orderSharePaise(commissionKeptPaise: number, shareBp: number): number {
  return Math.round((Math.max(0, commissionKeptPaise) * shareBp) / 10_000);
}
