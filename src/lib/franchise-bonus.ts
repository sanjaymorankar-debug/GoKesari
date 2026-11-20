/**
 * Monthly performance bonus for a paid franchise dealer code (owner brief 21-Nov-2026 00.30 IST, §2–§3).
 * Pure: the server supplies the month's counts and values per dealer code; money in paise, rates in basis points.
 *
 *   Registration base points = max(0, NEW SHOPS − target)
 *   Baseline                 = OPENING SHOPS × expected business per shop
 *   Business base points     = max(0, floor((actual business of OPENING SHOPS − baseline) ÷ slot))  (0 in a first month)
 *   Main points              = total base points ÷ base points per main point (2 decimals, never rounded up)
 *   Bonus                    = min(main points × bonus per main point, maximum)
 *   Commission rate          = recurring base share + bonus
 *   Rating                   = 5.0 + bonus % (at most 10.0)
 *   Recurring payout         = rate × GoKesari's commission % × net delivered value of ALL the code's shops
 */

export interface BonusSettings {
  /** One-time onboarding commission, bp of the shop registration fee excluding GST (2500 = 25%). */
  onboardingBp: number;
  /** Recurring base share of GoKesari's order commission, bp (2500 = 25%). */
  recurringBaseBp: number;
  /** GoKesari's order commission on order value, bp (200 = 2%). */
  gokesariCommissionBp: number;
  monthlyShopTarget: number;
  expectedBusinessPerShopPaise: number;
  businessSlotPaise: number;
  basePointsPerMainPoint: number;
  /** Bonus per main point, bp (100 = 1 percentage point). */
  bonusBpPerMainPoint: number;
  /** The most the bonus can add, bp (500 = 5 points). */
  bonusMaxBp: number;
}

export const DEFAULT_BONUS_SETTINGS: BonusSettings = {
  onboardingBp: 2500,
  recurringBaseBp: 2500,
  gokesariCommissionBp: 200,
  monthlyShopTarget: 60,
  expectedBusinessPerShopPaise: 10_000_000, // ₹1,00,000
  businessSlotPaise: 500_000, // ₹5,000
  basePointsPerMainPoint: 100,
  bonusBpPerMainPoint: 100,
  bonusMaxBp: 500,
};

export interface MonthInput {
  openingShops: number;
  newShops: number;
  /** Delivered order value in the month from the OPENING shops only, net of cancellations and refunds. */
  openingBusinessPaise: number;
  /** Delivered order value in the month from ALL the code's shops (opening + new), net. */
  allBusinessPaise: number;
  /** One-time onboarding commission of the month's new shops (already earned at activation). */
  onboardingPaise: number;
  /** Corrections carried forward (refunds after an earlier payout etc.), signed. */
  adjustmentsPaise?: number;
  /** False when the franchise has expired / is not renewed: no bonus (the base share continues within the tail). */
  bonusEligible?: boolean;
}

export interface MonthResult {
  openingShops: number;
  newShops: number;
  baselinePaise: number;
  actualBusinessPaise: number;
  registrationPoints: number;
  businessPoints: number;
  totalPoints: number;
  /** Two decimals. */
  mainPoints: number;
  bonusBp: number;
  commissionRateBp: number;
  /** 5.0 – 10.0, two decimals. */
  rating: number;
  recurringPaise: number;
  onboardingPaise: number;
  adjustmentsPaise: number;
  totalPayoutPaise: number;
}

export function monthlyBonus(input: MonthInput, s: BonusSettings): MonthResult {
  const opening = Math.max(0, Math.trunc(input.openingShops));
  const fresh = Math.max(0, Math.trunc(input.newShops));
  const registrationPoints = Math.max(0, fresh - s.monthlyShopTarget);
  const baselinePaise = opening * s.expectedBusinessPerShopPaise;
  // A first month (no opening shops): baseline 0 and no business points.
  const businessPoints = opening > 0 && s.businessSlotPaise > 0 ? Math.max(0, Math.floor((input.openingBusinessPaise - baselinePaise) / s.businessSlotPaise)) : 0;
  const totalPoints = registrationPoints + businessPoints;
  const mainPoints = s.basePointsPerMainPoint > 0 ? Math.floor((totalPoints * 100) / s.basePointsPerMainPoint) / 100 : 0;
  const eligible = input.bonusEligible !== false;
  const bonusBp = eligible ? Math.min(s.bonusMaxBp, Math.round(mainPoints * s.bonusBpPerMainPoint)) : 0;
  const commissionRateBp = s.recurringBaseBp + bonusBp;
  const rating = Math.min(10, Math.round((5 + bonusBp / 100) * 100) / 100);
  const recurringPaise = Math.round((input.allBusinessPaise * s.gokesariCommissionBp * commissionRateBp) / 100_000_000);
  const adjustmentsPaise = Math.trunc(input.adjustmentsPaise ?? 0);
  return {
    openingShops: opening,
    newShops: fresh,
    baselinePaise,
    actualBusinessPaise: input.openingBusinessPaise,
    registrationPoints,
    businessPoints,
    totalPoints,
    mainPoints,
    bonusBp,
    commissionRateBp,
    rating,
    recurringPaise,
    onboardingPaise: input.onboardingPaise,
    adjustmentsPaise,
    totalPayoutPaise: recurringPaise + input.onboardingPaise + adjustmentsPaise,
  };
}

/** Opening shops of the next month: this month's opening + new, less shops deactivated (brief §6). */
export const nextOpeningShops = (r: Pick<MonthResult, "openingShops" | "newShops">, deactivated = 0) => Math.max(0, r.openingShops + r.newShops - deactivated);

/** Whole rupees (₹30,00,000) from paise. */
export const lakhCr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
