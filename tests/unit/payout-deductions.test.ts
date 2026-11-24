/** docs/tax-register/PAYOUT_DEDUCTIONS.md: which adjustments are service earnings, and the production hold. */
import { describe, expect, it } from "vitest";

import { computeTds } from "@/server/rider-wallet/rules";
import { holdUnlessApproved, isServiceEarning } from "@/server/tax/payout-deductions";

describe("service earnings", () => {
  it("are positive shop adjustments from appointments, rentals and prescriptions, never the commission", () => {
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: "consult:b1:fee", amountPaise: 50_000, reason: "Appointment A-1: fee collected online" })).toBe(true);
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: "healthrent:r1:fee", amountPaise: 20_000, reason: "Rental" })).toBe(true);
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: "consult:b1:commission", amountPaise: -1_000, reason: "GoKesari commission 2% on appointment A-1" })).toBe(false);
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: "consult:b1:x", amountPaise: 1_000, reason: "GoKesari commission correction" })).toBe(false);
    expect(isServiceEarning({ type: "REFUND_SHOP", idempotencyKey: "consult:b1:fee", amountPaise: 1_000 })).toBe(false);
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: "shop-wallet:1", amountPaise: 1_000 })).toBe(false);
    expect(isServiceEarning({ type: "SHOP_ADJUSTMENT", idempotencyKey: null, amountPaise: 1_000 })).toBe(false);
  });
});

describe("hold on production", () => {
  it("refuses an unapproved rate on gokesari.com only", () => {
    expect(() => holdUnlessApproved(false, "Rider TDS s.194C", true)).toThrow(/held/);
    expect(() => holdUnlessApproved(true, "Rider TDS s.194C", true)).not.toThrow();
    expect(() => holdUnlessApproved(false, "Rider TDS s.194C", false)).not.toThrow();
  });
});

describe("194H through the shared calculator", () => {
  const rule = { tdsEnabled: true, tdsRatePanBp: 200, tdsRateNoPanBp: 2000, annualThresholdPaise: 2_000_000, singlePaymentThresholdPaise: 2_000_000 };
  it("nothing below the year's threshold, then catch-up on the whole year", () => {
    expect(computeTds(rule, { grossPaise: 500_000, paidThisYearPaise: 1_000_000, tdsThisYearPaise: 0, hasPan: true, maxPaise: 500_000 }).tdsPaise).toBe(0);
    // ₹15,000 paid + ₹10,000 now = ₹25,000 > ₹20,000: 2% of ₹25,000.
    expect(computeTds(rule, { grossPaise: 1_000_000, paidThisYearPaise: 1_500_000, tdsThisYearPaise: 0, hasPan: true, maxPaise: 1_000_000 }).tdsPaise).toBe(50_000);
    // Without PAN: 20%.
    expect(computeTds(rule, { grossPaise: 2_500_000, paidThisYearPaise: 0, tdsThisYearPaise: 0, hasPan: false, maxPaise: 2_500_000 })).toMatchObject({ tdsPaise: 500_000, rateBp: 2000 });
  });
});
