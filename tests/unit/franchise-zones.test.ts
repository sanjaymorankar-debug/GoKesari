/**
 * Owner's final brief 21-Nov-2026 08.06 IST: the pure rules — tier and fee (§5.2), the provisional seed (§5.3), the
 * zone description (§5.4), coupon discounts (§5.7), the one-time cases A1–B4 on ₹1,000 / ₹2,500 (§3.3) and parity (§3.4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_ONE_TIME_RATES as R, averageOf, caseOf, couponDiscounts, gstOn, oneTimeSplit, parityProblems, splitProportionally, tierFor, vsAverage, zoneDescription, type CaseCode } from "@/lib/franchise-zones";

describe("tier and fee (§5.2)", () => {
  it("exactly +10% and −10% are Standard; +10.1% Premier; −10.1% Emerging", () => {
    expect(tierFor(110, 100).tier).toBe("STANDARD");
    expect(tierFor(90, 100).tier).toBe("STANDARD");
    expect(tierFor(110.1, 100)).toMatchObject({ tier: "PREMIER", diffBp: 1010, feePaise: 16_500_000 }); // ₹1,65,150 → ₹1,65,000
    expect(tierFor(89.9, 100)).toMatchObject({ tier: "EMERGING", diffBp: -1010, feePaise: 13_500_000 }); // ₹1,34,850 → ₹1,35,000
  });
  it("Standard pays the standard fee; Premier / Emerging × (1 + difference), to the nearest ₹1,000", () => {
    expect(tierFor(105, 100).feePaise).toBe(15_000_000);
    expect(tierFor(150, 99.4).feePaise).toBe(22_600_000); // ₹2,26,358 → ₹2,26,000
    expect(tierFor(50, 99.4).feePaise).toBe(7_500_000); // ₹75,452 → ₹75,000
  });
  it("optional minimum and maximum fee (off by default)", () => {
    const s = { standardFeePaise: 15_000_000, standardBandBp: 1000, feeMinPaise: 10_000_000, feeMaxPaise: 20_000_000 };
    expect(tierFor(50, 99.4, s).feePaise).toBe(10_000_000);
    expect(tierFor(150, 99.4, s).feePaise).toBe(20_000_000);
  });
  it("the seed file's 50 zones: average 99.4, every fee and tier reproduced, 20 / 12 / 18", () => {
    const csv = readFileSync(join(__dirname, "../../docs/franchise/data/GoKesari_Pune_Franchise_Zones_Seed.csv"), "utf8").trim().split("\n").slice(1);
    const rows = csv.map((l) => {
      const c = l.match(/("[^"]*"|[^,]*)(,|$)/g)!.map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
      return { index: Number(c[3]), tier: c[5].toUpperCase(), fee: Number(c[6]) };
    });
    expect(rows).toHaveLength(50);
    const avg = averageOf(rows.map((r) => r.index));
    expect(avg).toBeCloseTo(99.4, 10);
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const t = tierFor(r.index, avg);
      expect([t.tier, t.feePaise / 100]).toEqual([r.tier, r.fee]);
      counts[t.tier] = (counts[t.tier] ?? 0) + 1;
    }
    expect(counts).toEqual({ PREMIER: 20, STANDARD: 12, EMERGING: 18 });
  });
});

describe("zone description (§5.4) — positive for every tier", () => {
  it("the brief's two examples", () => {
    expect(zoneDescription({ tier: "PREMIER", diffBp: 5091, reason: "Wholesale trade peths (Raviwar, Budhwar, Ganj)", feePaise: 22_600_000, setName: "Pune" })).toBe(
      "Premier zone – business about 51% above the Pune zone average. Wholesale trade peths (Raviwar, Budhwar, Ganj). Annual franchise fee ₹2,26,000 + GST.",
    );
    expect(zoneDescription({ tier: "EMERGING", diffBp: -2958, reason: "Newly merged, developing", feePaise: 10_600_000, setName: "Pune" })).toBe(
      "Emerging zone – business about 30% below the Pune zone average. Newly merged, developing, with room to grow. Annual franchise fee ₹1,06,000 + GST.",
    );
    expect(vsAverage(-2958)).toBe("−30%");
  });
  it("uses the admin's tier display names", () => {
    const display = { names: { PREMIER: "Platinum", STANDARD: "Established", EMERGING: "Developing" }, colours: { PREMIER: "#000000", STANDARD: "#000000", EMERGING: "#000000" } };
    expect(zoneDescription({ tier: "STANDARD", diffBp: 563, reason: "Established residential", feePaise: 15_000_000, setName: "Pune", display })).toMatch(/^Established zone – business within 6% of the Pune zone average/);
  });
});

describe("coupons (§5.7)", () => {
  const lines = [
    { zoneId: "GKZ-PUN-03", zoneSetCode: "PUN", tier: "PREMIER" as const, listPaise: 22_600_000 },
    { zoneId: "GKZ-PUN-47", zoneSetCode: "PUN", tier: "EMERGING" as const, listPaise: 7_500_000 },
  ];
  it("% of each eligible zone's fee", () => {
    expect(couponDiscounts({ discountType: "PERCENT", percentBp: 1000, flatPaise: null, maxDiscountPaise: null, scope: { all: true } }, lines)).toEqual([2_260_000, 750_000]);
  });
  it("a % cap is shared in proportion; parts add up exactly", () => {
    const d = couponDiscounts({ discountType: "PERCENT", percentBp: 5000, flatPaise: null, maxDiscountPaise: 1_000_000, scope: { all: true } }, lines);
    expect(d.reduce((s, v) => s + v, 0)).toBe(1_000_000);
    expect(d).toEqual([750_831, 249_169]);
  });
  it("flat split in proportion to the fees; scope by tier; never below ₹1", () => {
    expect(couponDiscounts({ discountType: "FLAT", percentBp: null, flatPaise: 3_010_000, maxDiscountPaise: null, scope: { all: true } }, lines)).toEqual([2_260_000, 750_000]);
    expect(couponDiscounts({ discountType: "FLAT", percentBp: null, flatPaise: 3_000_000, maxDiscountPaise: null, scope: { tiers: ["EMERGING"] } }, lines)).toEqual([0, 3_000_000]);
    expect(couponDiscounts({ discountType: "FLAT", percentBp: null, flatPaise: 99_999_999, maxDiscountPaise: null, scope: { zones: ["GKZ-PUN-47"] } }, lines)).toEqual([0, 7_499_900]);
    expect(splitProportionally(10, [0, 0], [5, 5])).toEqual([0, 0]);
  });
  it("GST on the discounted amount", () => {
    expect(gstOn(30_100_000 - 3_010_000, 1800)).toBe(4_876_200);
  });
});

describe("one-time cases (§3.3) on the default fees", () => {
  const table: Record<CaseCode, [number, number, number]> = {
    A1: [0, 0, 200],
    A2: [200, 0, 40],
    A3: [200, 40, 30],
    A4: [200, 0, 40],
    B1: [0, 0, 250],
    B2: [200, 0, 40],
    B3: [200, 40, 30],
    B4: [200, 0, 40],
  };
  for (const [c, [direct, lead, top]] of Object.entries(table) as [CaseCode, [number, number, number]][]) {
    it(`${c}: retail ₹1,000 and wholesale ₹2,500`, () => {
      const r = oneTimeSplit(c, 100_000, R);
      expect([r.direct, r.lead, r.top].map((p) => p / 100)).toEqual([direct, lead, top]);
      const w = oneTimeSplit(c, 250_000, R);
      expect([w.direct, w.lead, w.top].map((p) => p / 100)).toEqual([direct * 2.5, lead * 2.5, top * 2.5]);
    });
  }
  it("totals: A3 and B3 both ₹270 / ₹675 (owner, 21-Nov-2026: the same 20/4/3 flow)", () => {
    const t = (c: CaseCode, fee: number) => Object.values(oneTimeSplit(c, fee, R)).slice(0, 3).reduce((s, v) => s + v, 0) / 100;
    expect([t("A3", 100_000), t("A3", 250_000), t("B3", 100_000), t("B3", 250_000)]).toEqual([270, 675, 270, 675]);
  });
  it("who registered → the case", () => {
    expect(caseOf("A", null, false)).toBe("A1");
    expect(caseOf("B", { role: "AGENT" }, false)).toBe("B2");
    expect(caseOf("B", { role: "AGENT" }, true)).toBe("B3");
    expect(caseOf("A", { role: "TEAM_LEAD" }, false)).toBe("A4");
  });
});

describe("parity (§3.4)", () => {
  it("the defaults pass; owner rates lower than the free dealer's are refused", () => {
    expect(parityProblems(R)).toEqual([]);
    expect(parityProblems({ ...R, ownerSelfBp: 1900 })[0]).toMatch(/own-shop rate/);
    expect(parityProblems({ ...R, ownerOverrideBp: 300 })[0]).toMatch(/override/);
    expect(parityProblems({ ...R, ownerSecondOverrideBp: 200 })[0]).toMatch(/second override/);
    expect(parityProblems({ ...R, dealerOverrideBp: 600 })[0]).toMatch(/cannot be lower/);
  });
});
