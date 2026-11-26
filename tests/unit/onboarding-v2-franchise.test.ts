/** Onboarding v2 franchise (docs/onboarding-v2-2026-11): plan pricing and the v2 rules text (no 30-day KYC rule). */
import { describe, expect, it } from "vitest";

import { FRANCHISE_AGREEMENT_TEXT, FRANCHISE_AGREEMENT_V2_TEXT, FRANCHISE_AGREEMENT_V2_VERSION, FRANCHISE_AGREEMENT_VERSION, franchiseAgreementFor, rupees } from "@/lib/franchise";
import { planPriceLabel, planZoneFeePaise } from "@/lib/franchise-plans";

const zone = { feePaise: 15_000_000, regularFeePaise: 22_600_000 };

describe("planZoneFeePaise", () => {
  it("a fixed price is the same for every zone", () => {
    expect(planZoneFeePaise({ pricePerZonePaise: 15_000_000, gstExtra: true, isLaunchOffer: true }, zone, 1800)).toBe(15_000_000);
    expect(planZoneFeePaise({ pricePerZonePaise: 15_000_000, gstExtra: true, isLaunchOffer: false }, { feePaise: 7_500_000, regularFeePaise: 7_500_000 }, 1800)).toBe(15_000_000);
  });
  it("no price: a launch plan takes what the zone sells for now, any other plan the regular tier fee", () => {
    expect(planZoneFeePaise({ pricePerZonePaise: null, gstExtra: true, isLaunchOffer: true }, zone, 1800)).toBe(15_000_000);
    expect(planZoneFeePaise({ pricePerZonePaise: null, gstExtra: true, isLaunchOffer: false }, zone, 1800)).toBe(22_600_000);
    expect(planZoneFeePaise({ pricePerZonePaise: null, gstExtra: true, isLaunchOffer: false }, { feePaise: 9_000_000, regularFeePaise: null }, 1800)).toBe(9_000_000);
    expect(planZoneFeePaise({ pricePerZonePaise: null, gstExtra: true, isLaunchOffer: false }, { feePaise: null, regularFeePaise: null }, 1800)).toBeNull();
  });
  it("a GST-inclusive price is turned into its fee before GST", () => {
    expect(planZoneFeePaise({ pricePerZonePaise: 11_800_000, gstExtra: false, isLaunchOffer: false }, zone, 1800)).toBe(10_000_000);
  });
  it("labels", () => {
    expect(planPriceLabel({ pricePerZonePaise: 15_000_000, gstExtra: true, isLaunchOffer: true, durationMonths: 12 }, rupees)).toBe("₹1,50,000 + GST per zone · 12 months");
    expect(planPriceLabel({ pricePerZonePaise: null, gstExtra: true, isLaunchOffer: false, durationMonths: 1 }, rupees)).toBe("Zone tier fee + GST per zone · 1 month");
  });
});

describe("v2 franchise rules", () => {
  it("drop the 30-day KYC / refund rule and keep everything else", () => {
    expect(FRANCHISE_AGREEMENT_TEXT.join(" ")).toMatch(/within 30 days of the payment/);
    expect(FRANCHISE_AGREEMENT_V2_TEXT.join(" ")).not.toMatch(/30 days of the payment|refund the fee and release/);
    expect(FRANCHISE_AGREEMENT_V2_TEXT.join(" ")).toMatch(/live as soon as the payment succeeds/);
    expect(FRANCHISE_AGREEMENT_V2_TEXT.join(" ")).toMatch(/before my first payout/);
    expect(FRANCHISE_AGREEMENT_V2_TEXT).toHaveLength(FRANCHISE_AGREEMENT_TEXT.length);
    expect(FRANCHISE_AGREEMENT_V2_TEXT.slice(5)).toEqual(FRANCHISE_AGREEMENT_TEXT.slice(5));
    expect(FRANCHISE_AGREEMENT_V2_VERSION.length).toBeLessThanOrEqual(20); // the agreement API accepts at most 20 characters
    expect(franchiseAgreementFor(false).version).toBe(FRANCHISE_AGREEMENT_VERSION);
    expect(franchiseAgreementFor(true).version).toBe(FRANCHISE_AGREEMENT_V2_VERSION);
  });
});
