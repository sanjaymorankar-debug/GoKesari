/**
 * One-time registration fee by declared annual turnover, in slabs (owner,
 * 28 Oct 2026): three to start — up to ₹2 crore, up to ₹10 crore, above
 * ₹10 crore — and the admin may add or remove slabs (up to 20). Limits and fees
 * are the admin rule registrationFeeByTurnover, GST on top; a value saved in the
 * older three-slab form still reads. And the professional shop types that come
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
  turnoverSlab,
  turnoverSlabLabel,
  type TurnoverFeeRule,
} from "@/lib/registration-fee";
import { isFoodBusinessShopType, isProfessionalShopType, SHOP_TYPE_KEYS } from "@/lib/shop-types";
import { RULES } from "@/server/config/rules";

const rule = RULES.registrationFeeByTurnover.defaults;
const CRORE = 1_00_00_000;

describe("registration fee by turnover slab — the default rule", () => {
  it("is on, with slabs up to ₹2 crore, up to ₹10 crore and above", () => {
    expect(rule).toEqual({
      enabled: true,
      slabs: [
        { upToRupees: 2 * CRORE, feePaise: 99_900 },
        { upToRupees: 10 * CRORE, feePaise: 4_99_900 },
        { upToRupees: null, feePaise: 9_99_900 },
      ],
    });
    expect(RULES.registrationFeeByTurnover.schema.safeParse(rule).success).toBe(true);
  });

  it("puts turnover up to and including ₹2 crore in slab 1", () => {
    for (const t of [0, 15_00_000, 2 * CRORE]) {
      expect(turnoverSlab(t, rule)).toBe(1);
      expect(feeForTurnover(t, rule)).toBe(99_900);
    }
  });

  it("puts turnover above ₹2 crore, up to and including ₹10 crore, in slab 2", () => {
    for (const t of [2 * CRORE + 1, 5 * CRORE, 10 * CRORE]) {
      expect(turnoverSlab(t, rule)).toBe(2);
      expect(feeForTurnover(t, rule)).toBe(4_99_900);
    }
  });

  it("puts turnover above ₹10 crore in slab 3", () => {
    for (const t of [10 * CRORE + 1, 500 * CRORE]) {
      expect(turnoverSlab(t, rule)).toBe(3);
      expect(feeForTurnover(t, rule)).toBe(9_99_900);
    }
  });

  it("names the slabs the way the form and admin screen show them", () => {
    expect(turnoverSlabLabel(1, rule)).toBe("Up to ₹2 crore");
    expect(turnoverSlabLabel(2, rule)).toBe("₹2 crore – ₹10 crore");
    expect(turnoverSlabLabel(3, rule)).toBe("Above ₹10 crore");
  });

  it("follows an admin's change of limits and fees", () => {
    const changed: TurnoverFeeRule = {
      enabled: true,
      slabs: [
        { upToRupees: 1 * CRORE, feePaise: 0 },
        { upToRupees: 5 * CRORE, feePaise: 2_49_900 },
        { upToRupees: null, feePaise: 14_99_900 },
      ],
    };
    expect(feeForTurnover(1 * CRORE, changed)).toBe(0);
    expect(feeForTurnover(1 * CRORE + 1, changed)).toBe(2_49_900);
    expect(feeForTurnover(5 * CRORE + 1, changed)).toBe(14_99_900);
  });

  it("refuses, in the older three-slab form, a negative fee, a zero limit, or slab 2's limit not above slab 1's", () => {
    const schema = RULES.registrationFeeByTurnover.schema;
    expect(schema.safeParse({ ...rule, slab3FeePaise: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...rule, slab1UpToRupees: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...rule, slab2UpToRupees: 2 * CRORE }).success).toBe(false);
    expect(schema.safeParse({ ...rule, slab2UpToRupees: 1 * CRORE }).success).toBe(false);
  });
});

describe("registration fee by turnover slab — more slabs (owner, 28 Oct 2026)", () => {
  const schema = RULES.registrationFeeByTurnover.schema;
  const five: TurnoverFeeRule = {
    enabled: true,
    slabs: [
      { upToRupees: 50_00_000, feePaise: 49_900 },
      { upToRupees: 2 * CRORE, feePaise: 99_900 },
      { upToRupees: 10 * CRORE, feePaise: 4_99_900 },
      { upToRupees: 50 * CRORE, feePaise: 9_99_900 },
      { upToRupees: null, feePaise: 19_99_900 },
    ],
  };

  it("accepts five slabs and charges each turnover its own slab's fee", () => {
    expect(schema.safeParse(five).success).toBe(true);
    const cases: [number, number, number][] = [
      [0, 1, 49_900],
      [50_00_000, 1, 49_900],
      [50_00_001, 2, 99_900],
      [2 * CRORE, 2, 99_900],
      [10 * CRORE, 3, 4_99_900],
      [50 * CRORE, 4, 9_99_900],
      [50 * CRORE + 1, 5, 19_99_900],
    ];
    for (const [t, slab, fee] of cases) {
      expect(turnoverSlab(t, five), String(t)).toBe(slab);
      expect(feeForTurnover(t, five), String(t)).toBe(fee);
    }
    expect([1, 2, 3, 4, 5].map((n) => turnoverSlabLabel(n, five))).toEqual([
      "Up to ₹50 lakh",
      "₹50 lakh – ₹2 crore",
      "₹2 crore – ₹10 crore",
      "₹10 crore – ₹50 crore",
      "Above ₹50 crore",
    ]);
  });

  it("accepts one slab for every turnover, and up to 20 slabs", () => {
    const one: TurnoverFeeRule = { enabled: true, slabs: [{ upToRupees: null, feePaise: 99_900 }] };
    expect(schema.safeParse(one).success).toBe(true);
    expect(feeForTurnover(500 * CRORE, one)).toBe(99_900);
    expect(turnoverSlabLabel(1, one)).toBe("Any turnover");
    const twenty = Array.from({ length: 20 }, (_, i) => ({ upToRupees: i === 19 ? null : (i + 1) * CRORE, feePaise: 1_000 * (i + 1) }));
    expect(schema.safeParse({ enabled: true, slabs: twenty }).success).toBe(true);
    expect(schema.safeParse({ enabled: true, slabs: [...twenty.slice(0, 19).map((s) => s), { upToRupees: 25 * CRORE, feePaise: 1 }, twenty[19]] }).success).toBe(false);
  });

  it("refuses no slabs, a last slab with a limit, a middle slab without one, and limits not rising", () => {
    expect(schema.safeParse({ enabled: true, slabs: [] }).success).toBe(false);
    expect(schema.safeParse({ enabled: true, slabs: [{ upToRupees: CRORE, feePaise: 1 }] }).success).toBe(false);
    expect(
      schema.safeParse({ enabled: true, slabs: [{ upToRupees: null, feePaise: 1 }, { upToRupees: null, feePaise: 2 }] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        enabled: true,
        slabs: [
          { upToRupees: 5 * CRORE, feePaise: 1 },
          { upToRupees: 2 * CRORE, feePaise: 2 },
          { upToRupees: null, feePaise: 3 },
        ],
      }).success,
    ).toBe(false);
  });

  it("reads a value saved in the older three-slab form as the same three slabs", () => {
    const old = {
      enabled: true,
      slab1UpToRupees: 1 * CRORE,
      slab2UpToRupees: 5 * CRORE,
      slab1FeePaise: 0,
      slab2FeePaise: 2_49_900,
      slab3FeePaise: 14_99_900,
    };
    // As the settings service reads it: the stored value merged over the defaults.
    const parsed = schema.safeParse({ ...rule, ...old });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      enabled: true,
      slabs: [
        { upToRupees: 1 * CRORE, feePaise: 0 },
        { upToRupees: 5 * CRORE, feePaise: 2_49_900 },
        { upToRupees: null, feePaise: 14_99_900 },
      ],
    });
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
