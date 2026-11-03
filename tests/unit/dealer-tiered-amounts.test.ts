/**
 * TIERED dealer commission and shop-refers-shop — the amounts (owner brief, 2 Nov 2026;
 * docs/dealer-programme/TIERED_COMMISSION.md). Pure functions, no database:
 * every registration-fee slab (₹999 / ₹4,999 / ₹9,999 before GST), the missing-level
 * cases, the 28% ceiling, the rating on the direct part only, renewal before GST,
 * TDS on and off with the threshold catch-up, the financial year, and the
 * shop-referral discount and code format.
 */
import { describe, expect, it } from "vitest";

import { formatBp, isShopReferralCode } from "@/lib/dealer-tiers";
import { financialYearBounds, renewalBasePaise, tdsForPayout, tierAmounts, tierRatesFor } from "@/server/dealers/tiered";
import { shopReferralDiscount } from "@/server/services/shop-referrals";

const RATES = { directBp: 2000, leadOverrideBp: 500, mainOverrideBp: 300, firstPartBp: 6000 };
const SLABS = [99_900, 499_900, 999_900] as const;

describe("TIERED amounts on the three fee slabs", () => {
  it.each([
    // fee, direct (20%), part 1 (60%), part 2, lead (5%), main (3%), total (28%)
    [99_900, 19_980, 11_988, 7_992, 4_995, 2_997, 27_972],
    [499_900, 99_980, 59_988, 39_992, 24_995, 14_997, 139_972],
    [999_900, 199_980, 119_988, 79_992, 49_995, 29_997, 279_972],
  ])("₹%i paise: agent under a lead — direct, both overrides, 28%% in all", (fee, direct, d1, d2, lead, main, total) => {
    const a = tierAmounts(fee, RATES, { hasLead: true, hasMain: true });
    expect(a).toMatchObject({ directPaise: direct, direct1Paise: d1, direct2Paise: d2, leadPaise: lead, mainPaise: main, totalPaise: total });
    expect(a.direct1Paise + a.direct2Paise).toBe(a.directPaise);
    expect(a.totalPaise).toBeLessThanOrEqual(Math.round((fee * 2800) / 10_000));
  });

  it.each(SLABS)("₹%i paise: agent straight under the main dealer — no lead override (missing level), 23%%", (fee) => {
    const a = tierAmounts(fee, RATES, { hasLead: false, hasMain: true });
    expect(a.leadPaise).toBe(0);
    expect(a.totalPaise).toBe(a.directPaise + Math.round((fee * 300) / 10_000));
  });

  it.each(SLABS)("₹%i paise: the main dealer signs it himself — direct only, no override to himself, 20%%", (fee) => {
    const a = tierAmounts(fee, RATES, { hasLead: false, hasMain: false });
    expect(a).toMatchObject({ leadPaise: 0, mainPaise: 0, totalPaise: Math.round((fee * 2000) / 10_000) });
  });

  it.each(SLABS)("₹%i paise: a team lead signs it — direct and the main override, no lead override to himself", (fee) => {
    const a = tierAmounts(fee, RATES, { hasLead: false, hasMain: true });
    expect(a.leadPaise).toBe(0);
    expect(a.mainPaise).toBe(Math.round((fee * 300) / 10_000));
  });

  it("the rating moves the direct part only (rating 6.0, step 1% → direct 21%), never below zero", () => {
    const up = tierAmounts(499_900, RATES, { hasLead: true, hasMain: true, ratingAdjustmentBp: 100 });
    expect(up.directPaise).toBe(Math.round((499_900 * 2100) / 10_000));
    expect(up.leadPaise).toBe(24_995);
    expect(up.mainPaise).toBe(14_997);
    const floor = tierAmounts(499_900, RATES, { hasLead: true, hasMain: true, ratingAdjustmentBp: -5000 });
    expect(floor.directPaise).toBe(0);
    expect(floor.leadPaise).toBe(24_995);
  });

  it("a development bonus (1%) is added on top for the former lead", () => {
    const a = tierAmounts(999_900, RATES, { hasLead: true, hasMain: true, developmentBp: 100 });
    expect(a.developmentPaise).toBe(9_999);
    expect(a.totalPaise).toBe(279_972 + 9_999);
  });

  it("a dealer's own rates win over the rule's defaults", () => {
    expect(tierRatesFor({ tierDirectBp: 2500, tierLeadOverrideBp: null, tierMainOverrideBp: 0 }, RATES)).toEqual({ directBp: 2500, leadOverrideBp: 500, mainOverrideBp: 0, firstPartBp: 6000 });
  });
});

describe("renewal commission is figured before GST", () => {
  it("₹1,178.82 paid with 18% GST → ₹999 base; 10% → ₹99.90", () => {
    const base = renewalBasePaise(117_882, 1800);
    expect(base).toBe(99_900);
    expect(Math.round((base * 1000) / 10_000)).toBe(9_990);
  });
  it("no GST → the amount itself", () => {
    expect(renewalBasePaise(499_900, 0)).toBe(499_900);
  });
});

describe("TDS on payouts (rule dealerPayoutTds)", () => {
  const rule = { rateBp: 200, thresholdPaise: 2_000_000 };
  it("off → nothing deducted", () => {
    expect(tdsForPayout({ grossPaise: 5_000_000, yearGrossBeforePaise: 0, yearTdsBeforePaise: 0, enabled: false, ...rule })).toBe(0);
  });
  it("on, below ₹20,000 in the year → nothing", () => {
    expect(tdsForPayout({ grossPaise: 1_500_000, yearGrossBeforePaise: 400_000, yearTdsBeforePaise: 0, enabled: true, ...rule })).toBe(0);
  });
  it("the payout that passes ₹20,000 deducts 2% on the whole year (catch-up)", () => {
    // ₹15,000 earlier without TDS + ₹10,000 now = ₹25,000 → 2% = ₹500.
    expect(tdsForPayout({ grossPaise: 1_000_000, yearGrossBeforePaise: 1_500_000, yearTdsBeforePaise: 0, enabled: true, ...rule })).toBe(50_000);
  });
  it("after that, 2% of each payout", () => {
    expect(tdsForPayout({ grossPaise: 1_000_000, yearGrossBeforePaise: 2_500_000, yearTdsBeforePaise: 50_000, enabled: true, ...rule })).toBe(20_000);
  });
  it("never more than the payout itself", () => {
    expect(tdsForPayout({ grossPaise: 10_000, yearGrossBeforePaise: 10_000_000, yearTdsBeforePaise: 0, enabled: true, ...rule })).toBe(10_000);
  });
  it("the financial year runs April to March in IST", () => {
    const { start, end } = financialYearBounds(new Date("2027-03-31T18:45:00Z")); // 00.15 IST on 1 Apr 2027
    expect(start.toISOString()).toBe("2027-03-31T18:30:00.000Z");
    expect(end.toISOString()).toBe("2028-03-31T18:30:00.000Z");
    expect(financialYearBounds(new Date("2027-03-31T18:00:00Z")).start.toISOString()).toBe("2026-03-31T18:30:00.000Z"); // 23.30 IST on 31 Mar
  });
});

describe("shop-refers-shop", () => {
  it.each([
    [99_900, 9_990],
    [499_900, 49_990],
    [999_900, 99_990],
  ])("10%% off a ₹%i paise fee = %i paise; nothing in wallet-credit mode", (fee, off) => {
    expect(shopReferralDiscount(fee, { referredMode: "DISCOUNT", referredDiscountBp: 1000 })).toBe(off);
    expect(shopReferralDiscount(fee, { referredMode: "WALLET_CREDIT", referredDiscountBp: 1000 })).toBe(0);
  });
  it("never more than the fee", () => {
    expect(shopReferralDiscount(99_900, { referredMode: "DISCOUNT", referredDiscountBp: 20_000 })).toBe(99_900);
  });
  it("a shop code is SHOP + 5, never an 8-character dealer or customer code", () => {
    expect(isShopReferralCode("SHOPAB2CD")).toBe(true);
    expect(isShopReferralCode("shop-ab2cd")).toBe(true);
    expect(isShopReferralCode("GKAB2CDE")).toBe(false);
    expect(isShopReferralCode("SHOPAB2C")).toBe(false);
    expect(isShopReferralCode("SHOPAB0CD")).toBe(false);
  });
  it("formats basis points", () => {
    expect(formatBp(2000)).toBe("20%");
    expect(formatBp(250)).toBe("2.5%");
  });
});
