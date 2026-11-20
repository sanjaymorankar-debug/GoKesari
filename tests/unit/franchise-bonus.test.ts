/**
 * Owner brief 21-Nov-2026 00.30 IST §4: the monthly bonus test cases TC1–TC6 (TC5's carried adjustment is the
 * `adjustmentsPaise` line here; the end-to-end refund-after-payout case is in tests/integration/franchise-pmr.test.ts).
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_BONUS_SETTINGS as S, monthlyBonus, nextOpeningShops } from "@/lib/franchise-bonus";

const LAKH = 100_000 * 100; // ₹1,00,000 in paise
const CRORE = 100 * LAKH;

describe("TC1 – January, the dealer's first month", () => {
  const jan = monthlyBonus({ openingShops: 0, newShops: 70, openingBusinessPaise: 0, allBusinessPaise: 0, onboardingPaise: 70 * 25_000 }, S);
  it("baseline ₹0, business points 0, registration points 10", () => {
    expect(jan).toMatchObject({ baselinePaise: 0, businessPoints: 0, registrationPoints: 10, totalPoints: 10, mainPoints: 0.1 });
  });
  it("bonus 0.10% → rate 25.10%, rating 5.10", () => {
    expect(jan).toMatchObject({ bonusBp: 10, commissionRateBp: 2510, rating: 5.1 });
  });
  it("first-month shops can never earn business points, however much they sell", () => {
    expect(monthlyBonus({ openingShops: 0, newShops: 70, openingBusinessPaise: 0, allBusinessPaise: 5 * CRORE, onboardingPaise: 0 }, S).businessPoints).toBe(0);
  });
});

describe("TC2 – February, the cap applies", () => {
  const allFeb = 2 * CRORE; // the 70 + 75 shops' February orders (any figure; the rate applies to all of it)
  const feb = monthlyBonus({ openingShops: 70, newShops: 75, openingBusinessPaise: CRORE, allBusinessPaise: allFeb, onboardingPaise: 75 * 25_000 }, S);
  it("baseline ₹70L; (₹1 Cr − ₹70L) ÷ ₹5K = 600 business points; 15 registration points", () => {
    expect(feb).toMatchObject({ baselinePaise: 70 * LAKH, businessPoints: 600, registrationPoints: 15, totalPoints: 615, mainPoints: 6.15 });
  });
  it("6.15 main points capped at 5 → bonus 5% → rate 30%, rating 10.0", () => {
    expect(feb).toMatchObject({ bonusBp: 500, commissionRateBp: 3000, rating: 10 });
  });
  it("30% × 2% on ALL shops' value, plus 75 × ₹250 onboarding", () => {
    expect(feb.recurringPaise).toBe(Math.round(allFeb * 0.02 * 0.3));
    expect(feb.onboardingPaise).toBe(1_875_000); // ₹18,750
    expect(feb.totalPayoutPaise).toBe(feb.recurringPaise + 1_875_000);
  });
});

describe("TC3 – March rolls forward", () => {
  it("opening shops 70 + 75 = 145 → baseline ₹1.45 Cr", () => {
    const opening = nextOpeningShops({ openingShops: 70, newShops: 75 });
    expect(opening).toBe(145);
    expect(monthlyBonus({ openingShops: opening, newShops: 0, openingBusinessPaise: 0, allBusinessPaise: 0, onboardingPaise: 0 }, S).baselinePaise).toBe(145 * LAKH);
  });
  it("a shop deactivated by an admin leaves the next month's opening shops", () => {
    expect(nextOpeningShops({ openingShops: 70, newShops: 75 }, 3)).toBe(142);
  });
});

describe("TC4 – below target", () => {
  it("120 opening (₹1.2 Cr), 45 new, ₹1.1 Cr → 0 points (never negative), 25%, rating 5.0", () => {
    const r = monthlyBonus({ openingShops: 120, newShops: 45, openingBusinessPaise: 110 * LAKH, allBusinessPaise: 110 * LAKH, onboardingPaise: 0 }, S);
    expect(r).toMatchObject({ baselinePaise: 120 * LAKH, registrationPoints: 0, businessPoints: 0, totalPoints: 0, bonusBp: 0, commissionRateBp: 2500, rating: 5 });
  });
});

describe("TC5 – adjustment after payout", () => {
  it("a refund on an order already paid on comes off the next month's statement", () => {
    // ₹10,000 refunded in April on a March order paid on 5 April: 25% × 2% × ₹10,000 = ₹50 back.
    const april = monthlyBonus({ openingShops: 10, newShops: 0, openingBusinessPaise: 0, allBusinessPaise: 0, onboardingPaise: 0, adjustmentsPaise: -5_000 }, S);
    expect(april.totalPayoutPaise).toBe(-5_000);
    expect(april.adjustmentsPaise).toBe(-5_000);
  });
});

describe("TC6 – setting change", () => {
  it("with a ₹50K slot, TC2 gives 15 + 60 = 75 points → 0.75 main points → 25.75%", () => {
    const r = monthlyBonus({ openingShops: 70, newShops: 75, openingBusinessPaise: CRORE, allBusinessPaise: CRORE, onboardingPaise: 0 }, { ...S, businessSlotPaise: 5_000_000 });
    expect(r).toMatchObject({ businessPoints: 60, totalPoints: 75, mainPoints: 0.75, bonusBp: 75, commissionRateBp: 2575, rating: 5.75 });
  });
  it("the month uses the settings in force at its start (the server's config lookup; see the integration test)", () => {
    expect(monthlyBonus({ openingShops: 70, newShops: 75, openingBusinessPaise: CRORE, allBusinessPaise: CRORE, onboardingPaise: 0 }, S).commissionRateBp).toBe(3000);
  });
});

describe("special rules (§6)", () => {
  it("expired / not renewed: no bonus, the base 25% continues", () => {
    const r = monthlyBonus({ openingShops: 70, newShops: 75, openingBusinessPaise: CRORE, allBusinessPaise: CRORE, onboardingPaise: 0, bonusEligible: false }, S);
    expect(r).toMatchObject({ bonusBp: 0, commissionRateBp: 2500, rating: 5 });
    expect(r.recurringPaise).toBe(Math.round(CRORE * 0.02 * 0.25));
  });
});
