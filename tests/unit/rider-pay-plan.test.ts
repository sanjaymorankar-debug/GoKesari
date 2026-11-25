import { describe, expect, it } from "vitest";

import {
  PUNE_PILOT_PLAN,
  combineSurges,
  computeFinalPay,
  computeQuote,
  computeWaitPay,
  describePlan,
  extraLegPay,
  planProblems,
  roundUpToRupee,
  slabProblems,
  type PayPlanTerms,
} from "@/lib/rider-pay-plan";

const plan = PUNE_PILOT_PLAN;
const peak = { label: "Peak", multiplierBp: 12000, flatPaise: 0 };
const rain = { label: "Rain", multiplierBp: 13000, flatPaise: 1000 };

describe("rider pay plan — the brief's worked examples (section 3.2)", () => {
  it("D 5.4 km, P 1.8 km, peak ×1.2 → ₹55", () => {
    const q = computeQuote(plan, { legM: 5400, firstMileM: 1800 }, [peak]);
    expect(q.basePaise).toBe(2000);
    expect(q.lastMilePaise).toBe(2320); // 2 × 6 + 1.4 × 8
    expect(q.firstMilePaise).toBe(240); // 0.8 × 3
    expect(q.subtotalPaise).toBe(4560);
    expect(q.surgePaise).toBe(912); // 45.60 × 0.2
    expect(q.quotePaise).toBe(5500); // 54.72 → ₹55
    expect(q.roundingPaise).toBe(28);
  });

  it("a short job (D 0.6 km) gets the ₹30 minimum guarantee", () => {
    const q = computeQuote(plan, { legM: 600, firstMileM: 0 });
    expect(q.subtotalPaise).toBe(2000);
    expect(q.minTopUpPaise).toBe(1000);
    expect(q.quotePaise).toBe(3000);
  });
});

describe("slab edges", () => {
  const at = (km: number) => computeQuote({ ...plan, minGuaranteePaise: 0, longDistanceM: null }, { legM: km * 1000, firstMileM: 0 });
  it("exactly 2 km is covered by the base fee", () => expect(at(2).lastMilePaise).toBe(0));
  it("exactly 4 km = 2 km at ₹6", () => expect(at(4).lastMilePaise).toBe(1200));
  it("exactly 7 km = 2×6 + 3×8", () => expect(at(7).lastMilePaise).toBe(3600));
  it("exactly 10 km = 2×6 + 3×8 + 3×10", () => expect(at(10).lastMilePaise).toBe(6600));
  it("11 km adds ₹12 for the km above 10", () => expect(at(11).lastMilePaise).toBe(7800));
  it("one metre over a slab edge is paid at the next slab's rate", () => expect(at(4.001).lastMilePaise).toBe(1201));
});

describe("first mile, long distance, extra drops", () => {
  it("first mile is capped at ₹15", () => {
    expect(computeQuote(plan, { legM: 3000, firstMileM: 20_000 }).firstMilePaise).toBe(1500);
  });
  it("the free first km pays nothing", () => {
    expect(computeQuote(plan, { legM: 3000, firstMileM: 1000 }).firstMilePaise).toBe(0);
  });
  it("long-distance bonus starts at exactly 8 km", () => {
    expect(computeQuote(plan, { legM: 7999, firstMileM: 0 }).longDistancePaise).toBe(0);
    expect(computeQuote(plan, { legM: 8000, firstMileM: 0 }).longDistancePaise).toBe(1500);
  });
  it("an extra drop pays ₹10 plus slab pay on its own leg", () => {
    expect(extraLegPay(plan.slabs, 1000)).toBe(600); // below the first slab: first slab's rate
    const q = computeQuote(plan, { legM: 3000, firstMileM: 0, extraLegsM: [1000] });
    expect(q.extraDropPaise).toBe(1600);
  });
});

describe("surge, cap, rounding", () => {
  it("several surges: highest multiplier, flat amounts added", () => {
    const c = combineSurges([peak, rain, { label: "Festival", multiplierBp: 11000, flatPaise: 500 }]);
    expect(c.multiplierBp).toBe(13000);
    expect(c.flatPaise).toBe(1500);
    expect(c.labels).toEqual(["Peak", "Rain", "Festival"]);
  });
  it("rain ×1.3 + ₹10 on a ₹45.60 subtotal", () => {
    const q = computeQuote(plan, { legM: 5400, firstMileM: 1800 }, [peak, rain]);
    expect(q.surgePaise).toBe(Math.round(4560 * 0.3 + 1000));
    expect(q.quotePaise).toBe(roundUpToRupee(4560 * 1.3 + 1000));
  });
  it("the per-order cap holds even with surge", () => {
    const q = computeQuote(plan, { legM: 40_000, firstMileM: 5000 }, [rain]);
    expect(q.quotePaise).toBe(25_000);
    expect(q.capCutPaise).toBeGreaterThan(0);
  });
  it("rounds up to the next rupee but never on float noise", () => {
    expect(roundUpToRupee(5400.0000001)).toBe(5400);
    expect(roundUpToRupee(5401)).toBe(5500);
  });
  it("a surge never lowers pay (multiplier below 1 is ignored)", () => {
    expect(combineSurges([{ label: "x", multiplierBp: 9000, flatPaise: 0 }]).multiplierBp).toBe(10000);
  });
});

describe("final pay: quote lock, reroute tolerance, wait pay", () => {
  const quote = computeQuote(plan, { legM: 5000, firstMileM: 0 });
  it("an unchanged route pays exactly the quote", () => {
    expect(computeFinalPay(plan, { quote, actualLegM: 5000, waitMin: 0 }).tripPaise).toBe(quote.quotePaise);
  });
  it("a route within 15% keeps the quote", () => {
    const f = computeFinalPay(plan, { quote, actualLegM: 5750, waitMin: 0 });
    expect(f.rerouted).toBe(false);
    expect(f.tripPaise).toBe(quote.quotePaise);
  });
  it("a route more than 15% longer pays the higher re-worked amount", () => {
    const f = computeFinalPay(plan, { quote, actualLegM: 7000, waitMin: 0 });
    expect(f.rerouted).toBe(true);
    expect(f.tripPaise).toBeGreaterThan(quote.quotePaise);
  });
  it("a shorter route never lowers the locked quote", () => {
    expect(computeFinalPay(plan, { quote, actualLegM: 1000, waitMin: 0 }).tripPaise).toBe(quote.quotePaise);
  });
  it("wait: first 10 min free, ₹1/min, cap ₹20", () => {
    expect(computeWaitPay(plan, 10)).toBe(0);
    expect(computeWaitPay(plan, 15)).toBe(500);
    expect(computeWaitPay(plan, 90)).toBe(2000);
  });
});

describe("plan checks and words", () => {
  it("the pilot plan is valid", () => expect(planProblems(plan)).toEqual([]));
  it("finds a gap, an overlap and an open middle slab", () => {
    expect(slabProblems([{ fromM: 2000, toM: 4000, ratePaise: 600 }, { fromM: 5000, toM: null, ratePaise: 800 }], 2000)[0]).toMatch(/Gap/);
    expect(slabProblems([{ fromM: 2000, toM: 4000, ratePaise: 600 }, { fromM: 3000, toM: null, ratePaise: 800 }], 2000)[0]).toMatch(/overlap/);
    expect(slabProblems([{ fromM: 2000, toM: null, ratePaise: 600 }, { fromM: 4000, toM: null, ratePaise: 800 }], 2000).join(" ")).toMatch(/only the last/);
    expect(slabProblems([{ fromM: 0, toM: null, ratePaise: 600 }], 2000)[0]).toMatch(/must start at 2 km/);
  });
  it("rejects a cap below the minimum", () => {
    const bad: PayPlanTerms = { ...plan, maxPerOrderPaise: 1000 };
    expect(planProblems(bad).join(" ")).toMatch(/cap cannot be below/);
  });
  it("describes the plan in words", () => {
    const words = describePlan(plan).join("\n");
    expect(words).toContain("₹20 base fee covers the first 2 km");
    expect(words).toContain("Above 10 km: ₹12 per km.");
  });
  it("the migrated flat rate pays the same as before (base + per-km, no minimum)", () => {
    const flat: PayPlanTerms = {
      ...plan,
      baseFeePaise: 2000,
      baseIncludedM: 0,
      slabs: [{ fromM: 0, toM: null, ratePaise: 800 }],
      freeFirstMileM: 0,
      firstMileRatePaise: 0,
      firstMileCapPaise: 0,
      longDistanceM: null,
      minGuaranteePaise: 0,
      maxPerOrderPaise: null,
    };
    expect(computeQuote(flat, { legM: 3500, firstMileM: 900 }).subtotalPaise).toBe(2000 + 2800);
  });
});

import { calculatePlanEarning } from "@/lib/earnings-calc";

describe("pay-plan earning (ledger)", () => {
  const rules = { minimumEarningPaise: 0, failedDeliveryPayoutPercent: 50, cancelledAfterPickupPayoutPercent: 100, latePenaltyPaise: 0, lateGraceMinutes: 15 };
  const input = (outcome: "DELIVERED" | "FAILED") => ({
    outcome,
    distanceKm: 5.4,
    orderSubtotalPaise: 50000,
    at: new Date("2026-11-25T08:00:00Z"),
    timeZone: "Asia/Kolkata",
    dayCount: 1,
    weekCount: 1,
    minutesLate: null,
    alreadyAwarded: new Set<string>(),
    deliveryOrderId: "d1",
  });
  const quote = computeQuote(plan, { legM: 5400, firstMileM: 1800 }, [peak]);

  it("pays the locked quote plus wait pay, and the ledger sums to the total", () => {
    const e = calculatePlanEarning({ quote, tripPaise: quote.quotePaise, waitPaise: 500, waitMin: 15, planLabel: "Pilot v1" }, [], rules, input("DELIVERED"));
    expect(e.totalPaise).toBe(5500 + 500);
    expect(e.lines.reduce((n, l) => n + l.amountPaise, 0)).toBe(e.totalPaise);
  });

  it("a failed trip pays the rule's % of the quote (wait pay still paid)", () => {
    const e = calculatePlanEarning({ quote, tripPaise: quote.quotePaise, waitPaise: 500, waitMin: 15, planLabel: "Pilot v1" }, [], rules, input("FAILED"));
    expect(e.totalPaise).toBe(2750 + 500);
    expect(e.lines.reduce((n, l) => n + l.amountPaise, 0)).toBe(e.totalPaise);
  });

  it("a capped quote still balances", () => {
    const big = computeQuote(plan, { legM: 40_000, firstMileM: 5000 }, [rain]);
    const e = calculatePlanEarning({ quote: big, tripPaise: big.quotePaise, waitPaise: 0, waitMin: 0, planLabel: "Pilot v1" }, [], rules, input("DELIVERED"));
    expect(e.totalPaise).toBe(25_000);
    expect(e.lines.reduce((n, l) => n + l.amountPaise, 0)).toBe(25_000);
  });
});
