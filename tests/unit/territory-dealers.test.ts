/**
 * Territory dealers (owner, 20 Nov 2026): the rating and share formula and the pincode parser.
 * docs/dealer-programme/TERRITORY_DEALER.md
 */
import { describe, expect, it } from "vitest";

import { orderSharePaise, parsePincodes, territoryRating, territoryShareBp } from "@/lib/territory-dealers";

const RULE = { baseShareBp: 2000, stepBp: 100, maxShareBp: 2500 };

describe("territory share: 20% at rating 5, +1% a point, at most 25%", () => {
  it.each([
    [5, 2000],
    [6, 2100],
    [7.5, 2250],
    [9, 2400],
    [10, 2500],
    [4, 2000],
    [12, 2500],
  ])("rating %s → %s bp", (rating, bp) => {
    expect(territoryShareBp(rating, RULE)).toBe(bp);
  });

  it("never passes the maximum the admin set", () => {
    expect(territoryShareBp(10, { ...RULE, maxShareBp: 2200 })).toBe(2200);
  });
});

describe("territory rating: half from shop onboarding, half from product upload", () => {
  it("a new dealer with no shops is at the base 5", () => {
    expect(territoryRating({ onboardingRating: 5, shopsTotal: 0, shopsLive: 0, productWeightBp: 5000 })).toEqual({ onboardingPoints: 0, productPoints: 0, rating: 5 });
  });

  it("onboarding rating 9 and 3 of 4 shops live → 5 + 2 + 1.9 = 8.9", () => {
    // (9 − 5) / 5 × 2.5 = 2.0; 3/4 × 2.5 = 1.875 → 1.9
    expect(territoryRating({ onboardingRating: 9, shopsTotal: 4, shopsLive: 3, productWeightBp: 5000 })).toEqual({ onboardingPoints: 2, productPoints: 1.9, rating: 8.9 });
  });

  it("top on both → 10; a downgraded dealer below 5 counts as 5", () => {
    expect(territoryRating({ onboardingRating: 10, shopsTotal: 10, shopsLive: 10, productWeightBp: 5000 }).rating).toBe(10);
    expect(territoryRating({ onboardingRating: 3, shopsTotal: 2, shopsLive: 2, productWeightBp: 5000 })).toEqual({ onboardingPoints: 0, productPoints: 2.5, rating: 7.5 });
  });

  it("productWeightBp moves the split (all from product upload at 10000)", () => {
    expect(territoryRating({ onboardingRating: 10, shopsTotal: 2, shopsLive: 1, productWeightBp: 10_000 })).toEqual({ onboardingPoints: 0, productPoints: 2.5, rating: 7.5 });
  });
});

describe("order share and pincodes", () => {
  it("share of the commission kept, rounded to the paisa", () => {
    // ₹1,000 order at 2% = ₹20 commission; 20% → ₹4, 25% → ₹5
    expect(orderSharePaise(2000, 2000)).toBe(400);
    expect(orderSharePaise(2000, 2500)).toBe(500);
    expect(orderSharePaise(-5, 2000)).toBe(0);
  });

  it("parses pincodes separated by commas, spaces or lines and reports bad ones", () => {
    expect(parsePincodes("411038, 411029\n411038 41100 012345")).toEqual({ pincodes: ["411029", "411038"], invalid: ["41100", "012345"] });
  });
});
