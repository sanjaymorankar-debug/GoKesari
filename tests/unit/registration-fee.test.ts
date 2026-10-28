/**
 * One-time registration fee by declared annual turnover (owner request,
 * 26 Oct 2026): up to ₹2 crore → ₹999, above ₹2 crore → ₹4,999, both set by
 * rule registrationFeeByTurnover — switched off by default since 27 Oct 2026
 * (a flat ₹999 for now, from Admin → Registration fee). And the professional shop types that come
 * with it.
 */
import { describe, expect, it } from "vitest";

import {
  feeForTurnover,
  formatGstRate,
  formatRupeesIndian,
  parseTurnoverRupees,
  registrationCouponDiscount,
  registrationFeeBreakdown,
} from "@/lib/registration-fee";
import { isFoodBusinessShopType, isProfessionalShopType, SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { RULES } from "@/server/config/rules";

const rule = { ...RULES.registrationFeeByTurnover.defaults, enabled: true };
const CRORE = 1_00_00_000;

describe("registration fee by turnover — the default rule", () => {
  it("is off for now (flat fee), keeping the owner's tiers: up to ₹2 crore ₹999, above ₹4,999", () => {
    expect(RULES.registrationFeeByTurnover.defaults).toEqual({
      enabled: false,
      thresholdRupees: 2 * CRORE,
      upToFeePaise: 99_900,
      aboveFeePaise: 4_99_900,
    });
    expect(RULES.registrationFeeByTurnover.schema.safeParse(rule).success).toBe(true);
  });

  it("charges ₹999 up to and including ₹2 crore", () => {
    expect(feeForTurnover(0, rule)).toBe(99_900);
    expect(feeForTurnover(15_00_000, rule)).toBe(99_900);
    expect(feeForTurnover(1 * CRORE, rule)).toBe(99_900);
    expect(feeForTurnover(2 * CRORE, rule)).toBe(99_900);
  });

  it("charges ₹4,999 above ₹2 crore", () => {
    expect(feeForTurnover(2 * CRORE + 1, rule)).toBe(4_99_900);
    expect(feeForTurnover(50 * CRORE, rule)).toBe(4_99_900);
  });

  it("follows an admin's change of threshold and amounts", () => {
    const changed = { enabled: true, thresholdRupees: 1 * CRORE, upToFeePaise: 1_49_900, aboveFeePaise: 5_99_900 };
    expect(feeForTurnover(1 * CRORE, changed)).toBe(1_49_900);
    expect(feeForTurnover(1 * CRORE + 1, changed)).toBe(5_99_900);
  });

  it("refuses a negative fee or threshold in the rule", () => {
    const schema = RULES.registrationFeeByTurnover.schema;
    expect(schema.safeParse({ ...rule, upToFeePaise: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...rule, thresholdRupees: 0 }).success).toBe(false);
  });
});

describe("the turnover field", () => {
  it("takes whole rupees, with Indian or Western commas, spaces or ₹", () => {
    expect(parseTurnoverRupees("1500000")).toBe(15_00_000);
    expect(parseTurnoverRupees("1,50,00,000")).toBe(1_50_00_000);
    expect(parseTurnoverRupees(" ₹ 20,000,000 ")).toBe(2 * CRORE);
    expect(parseTurnoverRupees("0")).toBe(0);
  });

  it("refuses empty, decimals, negatives, words and absurd amounts", () => {
    for (const raw of ["", "  ", "15.5", "-100", "2 crore", "1e7", "9".repeat(20)]) {
      expect(parseTurnoverRupees(raw), raw).toBeNull();
    }
  });

  it("reads amounts the Indian way", () => {
    expect(formatRupeesIndian(2 * CRORE)).toBe("₹2 crore");
    expect(formatRupeesIndian(2.5 * CRORE)).toBe("₹2.5 crore");
    expect(formatRupeesIndian(15_00_000)).toBe("₹15 lakh");
    expect(formatRupeesIndian(75_000)).toBe("₹75,000");
  });
});

describe("professional shop types", () => {
  it("are registrable shop types, not food businesses", () => {
    for (const key of ["PROFESSIONAL_OFFICE", "CONSULTANT", "DOCTOR_CLINIC", "SUPER_SPECIALITY_CLINIC"]) {
      expect(SHOP_TYPE_KEYS).toContain(key);
      expect(isProfessionalShopType(key)).toBe(true);
      expect(isFoodBusinessShopType(key)).toBe(false);
    }
    expect(isProfessionalShopType("DAIRY")).toBe(false);
    expect(isProfessionalShopType("BAKERY")).toBe(false);
  });
});

describe("the fee as paid: base, less a coupon, plus GST (owner, 27 Oct 2026)", () => {
  it("₹999 + 18% GST = ₹1,178.82", () => {
    expect(registrationFeeBreakdown(99_900, 0, 1800)).toEqual({
      basePaise: 99_900,
      discountPaise: 0,
      taxablePaise: 99_900,
      gstRateBp: 1800,
      gstPaise: 17_982,
      totalPaise: 1_17_882,
    });
  });

  it("charges GST on the fee after the coupon", () => {
    expect(registrationFeeBreakdown(99_900, 20_000, 1800)).toMatchObject({ taxablePaise: 79_900, gstPaise: 14_382, totalPaise: 94_282 });
  });

  it("never discounts below zero; a full discount leaves nothing to pay", () => {
    expect(registrationFeeBreakdown(99_900, 5_00_000, 1800)).toMatchObject({ discountPaise: 99_900, gstPaise: 0, totalPaise: 0 });
  });

  it("splits back exactly as GoKesari's fee invoice reads a GST-inclusive fee", () => {
    for (let base = 1; base <= 10_00_000; base += 997) {
      const { taxablePaise, totalPaise } = registrationFeeBreakdown(base, 0, 1800);
      expect(Math.round((totalPaise * 10_000) / (10_000 + 1800)), String(base)).toBe(taxablePaise);
    }
  });

  it("prices flat and percentage coupons on the base fee, capped", () => {
    const flat = { discountType: "FLAT" as const, flatPaise: 20_000, percent: null, maxDiscountPaise: null };
    const pct = { discountType: "PERCENT" as const, flatPaise: null, percent: 50, maxDiscountPaise: null };
    expect(registrationCouponDiscount(flat, 99_900)).toBe(20_000);
    expect(registrationCouponDiscount({ ...flat, flatPaise: 2_00_000 }, 99_900)).toBe(99_900);
    expect(registrationCouponDiscount(pct, 99_900)).toBe(49_950);
    expect(registrationCouponDiscount({ ...pct, maxDiscountPaise: 30_000 }, 99_900)).toBe(30_000);
  });

  it("shows the rate as a percentage", () => {
    expect(formatGstRate(1800)).toBe("18%");
    expect(formatGstRate(1250)).toBe("12.5%");
    expect(formatGstRate(0)).toBe("0%");
  });
});
