import { describe, expect, it } from "vitest";

import {
  calculateEarning,
  inWindow,
  localTime,
  pickSlot,
  type EarningInput,
  type EarningRules,
  type IncentiveRule,
  type SlotRule,
} from "@/lib/earnings-calc";

const DEFAULTS = { baseFeePaise: 2000, perKmFeePaise: 800 };
const RULES: EarningRules = {
  minimumEarningPaise: 0,
  failedDeliveryPayoutPercent: 100,
  cancelledAfterPickupPayoutPercent: 100,
  latePenaltyPaise: 0,
  lateGraceMinutes: 15,
};
const TZ = "Asia/Kolkata";
// 2026-09-30 09:30 IST (a Wednesday)
const MORNING = new Date("2026-09-30T04:00:00Z");

const slot = (over: Partial<SlotRule>): SlotRule => ({
  id: "s1",
  name: "Morning",
  startTime: "06:00",
  endTime: "11:00",
  daysOfWeek: [],
  baseFeePaise: null,
  perKmFeePaise: null,
  minEarningPaise: null,
  orderFeePaise: 0,
  orderPercentBp: 0,
  peakBonusPaise: 0,
  isPeak: false,
  priority: 0,
  validFrom: null,
  validTo: null,
  createdAt: new Date("2026-01-01"),
  ...over,
});

const incentive = (over: Partial<IncentiveRule>): IncentiveRule => ({
  id: "i1",
  name: "Incentive",
  type: "DAILY_TARGET",
  thresholdValue: 5,
  rewardPaise: 5000,
  period: "DAY",
  startTime: null,
  endTime: null,
  daysOfWeek: [],
  validFrom: null,
  validTo: null,
  ...over,
});

const input = (over: Partial<EarningInput> = {}): EarningInput => ({
  outcome: "DELIVERED",
  distanceKm: 3,
  orderSubtotalPaise: 30_000,
  at: MORNING,
  timeZone: TZ,
  dayCount: 1,
  weekCount: 1,
  minutesLate: null,
  alreadyAwarded: new Set(),
  deliveryOrderId: "d1",
  ...over,
});

const sum = (b: ReturnType<typeof calculateEarning>) => b.lines.reduce((n, l) => n + l.amountPaise, 0);

describe("local time helpers", () => {
  it("reads the local clock, weekday and ISO week", () => {
    const t = localTime(MORNING, TZ);
    expect(t).toMatchObject({ dateKey: "2026-09-30", minutes: 9 * 60 + 30, weekday: 3, weekKey: "2026-W40" });
  });

  it("windows are [start, end) and may cross midnight", () => {
    expect(inWindow(6 * 60, "06:00", "11:00")).toBe(true);
    expect(inWindow(11 * 60, "06:00", "11:00")).toBe(false);
    expect(inWindow(23 * 60 + 30, "22:00", "02:00")).toBe(true);
    expect(inWindow(60, "22:00", "02:00")).toBe(true);
    expect(inWindow(3 * 60, "22:00", "02:00")).toBe(false);
  });
});

describe("slot selection", () => {
  it("the highest-priority active slot containing the time wins", () => {
    const low = slot({ id: "low", priority: 0 });
    const high = slot({ id: "high", priority: 5, startTime: "09:00", endTime: "10:00" });
    expect(pickSlot([low, high], MORNING, TZ)?.id).toBe("high");
  });

  it("respects weekdays and validity dates", () => {
    expect(pickSlot([slot({ daysOfWeek: [0, 6] })], MORNING, TZ)).toBeNull(); // weekend-only, today is Wednesday
    expect(pickSlot([slot({ validTo: "2026-09-29" })], MORNING, TZ)).toBeNull();
    expect(pickSlot([slot({ validFrom: "2026-09-30" })], MORNING, TZ)).not.toBeNull();
  });
});

describe("calculateEarning", () => {
  it("with no slot or incentive it is exactly base + per-km (today's behaviour)", () => {
    const b = calculateEarning(DEFAULTS, [], [], RULES, input());
    expect(b).toMatchObject({ basePaise: 2000, distancePaise: 2400, totalPaise: 4400, slotId: null, deductionsPaise: 0 });
    expect(sum(b)).toBe(b.totalPaise);
  });

  it("a slot supplies its own rates, order component and peak bonus", () => {
    const b = calculateEarning(
      DEFAULTS,
      [slot({ baseFeePaise: 3000, perKmFeePaise: 500, orderFeePaise: 200, orderPercentBp: 100, peakBonusPaise: 1000, isPeak: true })],
      [],
      RULES,
      input(),
    );
    // base 3000 + 3 km × 500 + (200 + 1% of 30000) + 1000 peak
    expect(b).toMatchObject({ basePaise: 3000, distancePaise: 1500, orderComponentPaise: 500, slotIncentivePaise: 1000, totalPaise: 6000 });
    expect(b.slotName).toBe("Morning");
    expect(sum(b)).toBe(6000);
  });

  it("tops up to the minimum earning per order", () => {
    const b = calculateEarning(DEFAULTS, [], [], { ...RULES, minimumEarningPaise: 6000 }, input({ distanceKm: 0 }));
    expect(b).toMatchObject({ minTopUpPaise: 4000, totalPaise: 6000 });
    // a slot's own minimum outranks the global one
    const s = calculateEarning(DEFAULTS, [slot({ minEarningPaise: 3000 })], [], { ...RULES, minimumEarningPaise: 9000 }, input({ distanceKm: 0 }));
    expect(s.totalPaise).toBe(3000);
  });

  it("daily and weekly targets pay once, on the delivery that reaches them", () => {
    const daily = incentive({ type: "DAILY_TARGET", thresholdValue: 5 });
    expect(calculateEarning(DEFAULTS, [], [daily], RULES, input({ dayCount: 4 })).awards).toHaveLength(0);
    const hit = calculateEarning(DEFAULTS, [], [daily], RULES, input({ dayCount: 5 }));
    expect(hit.awards).toHaveLength(1);
    expect(hit.orderIncentivePaise).toBe(5000);
    expect(hit.totalPaise).toBe(4400 + 5000);
    // already paid for that day: not again
    const again = calculateEarning(DEFAULTS, [], [daily], RULES, input({ dayCount: 5, alreadyAwarded: new Set(["i1:2026-09-30"]) }));
    expect(again.awards).toHaveLength(0);

    const weekly = incentive({ id: "w", type: "WEEKLY_TARGET", thresholdValue: 20 });
    expect(calculateEarning(DEFAULTS, [], [weekly], RULES, input({ weekCount: 20 })).awards[0]?.periodKey).toBe("2026-W40");
  });

  it("order-count pays on every delivery beyond the Nth; distance and peak-hour rules apply to the order", () => {
    const beyond = incentive({ id: "c", type: "ORDER_COUNT", thresholdValue: 3, rewardPaise: 1000 });
    expect(calculateEarning(DEFAULTS, [], [beyond], RULES, input({ dayCount: 3 })).awards).toHaveLength(0);
    expect(calculateEarning(DEFAULTS, [], [beyond], RULES, input({ dayCount: 4 })).awards).toHaveLength(1);

    const far = incentive({ id: "f", type: "DISTANCE", thresholdValue: 2500, rewardPaise: 700 });
    expect(calculateEarning(DEFAULTS, [], [far], RULES, input({ distanceKm: 2.4 })).awards).toHaveLength(0);
    const longTrip = calculateEarning(DEFAULTS, [], [far], RULES, input({ distanceKm: 3 }));
    expect(longTrip.otherIncentivePaise).toBe(700);

    const peak = incentive({ id: "p", type: "PEAK_HOUR", startTime: "09:00", endTime: "10:00", rewardPaise: 900, thresholdValue: 0 });
    expect(calculateEarning(DEFAULTS, [], [peak], RULES, input()).slotIncentivePaise).toBe(900); // 09:30 is inside
  });

  it("incentives reward completed drops only", () => {
    const daily = incentive({ thresholdValue: 1 });
    const failed = calculateEarning(DEFAULTS, [], [daily], RULES, input({ outcome: "FAILED", dayCount: 1 }));
    expect(failed.awards).toHaveLength(0);
  });

  it("failed and cancelled-after-pickup trips are paid per configuration", () => {
    const half = { ...RULES, failedDeliveryPayoutPercent: 50 };
    const b = calculateEarning(DEFAULTS, [], [], half, input({ outcome: "FAILED" }));
    expect(b.totalPaise).toBe(2200);
    expect(b.deductionsPaise).toBe(2200);
    expect(sum(b)).toBe(b.totalPaise);

    // D10: cancelled after pickup is paid in full by default
    const cancelled = calculateEarning(DEFAULTS, [], [], RULES, input({ outcome: "CANCELLED_AFTER_PICKUP" }));
    expect(cancelled).toMatchObject({ totalPaise: 4400, deductionsPaise: 0 });
  });

  it("a late drop can carry a configured penalty, never more than the earning", () => {
    const rules = { ...RULES, latePenaltyPaise: 500 };
    expect(calculateEarning(DEFAULTS, [], [], rules, input({ minutesLate: 10 })).deductionsPaise).toBe(0); // within grace
    const late = calculateEarning(DEFAULTS, [], [], rules, input({ minutesLate: 40 }));
    expect(late.deductionsPaise).toBe(500);
    expect(late.totalPaise).toBe(3900);
    const tiny = calculateEarning({ baseFeePaise: 100, perKmFeePaise: 0 }, [], [], { ...rules, latePenaltyPaise: 5000 }, input({ minutesLate: 60, distanceKm: 0 }));
    expect(tiny.totalPaise).toBe(0);
  });
});
