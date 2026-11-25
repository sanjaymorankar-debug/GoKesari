/** Rider App v2 growth features: tier selection, slot date / cut-off maths, referral window. */
import { describe, expect, it } from "vitest";

import {
  addDaysKey,
  bookableDates,
  canBook,
  canCancel,
  newReferralCode,
  normaliseReferralCode,
  pct,
  pickTier,
  referralState,
  reminderDue,
  slotBoostTags,
  slotRunsOn,
  slotWindow,
  weekdayOfKey,
  zonedInstant,
  type TierMetrics,
  type TierRule,
} from "@/lib/rider-growth";

const TZ = "Asia/Kolkata";

const TIERS: TierRule[] = [
  { name: "Bronze", minDeliveries: 0, minRatingX100: 0, minAcceptancePct: 0, minOnTimePct: 0, extraIncentivePct: 0, priority: false },
  { name: "Silver", minDeliveries: 30, minRatingX100: 400, minAcceptancePct: 70, minOnTimePct: 80, extraIncentivePct: 2, priority: false },
  { name: "Gold", minDeliveries: 70, minRatingX100: 440, minAcceptancePct: 80, minOnTimePct: 90, extraIncentivePct: 5, priority: true },
];

const metrics = (m: Partial<TierMetrics>): TierMetrics => ({
  deliveries: 0,
  ratingX100: 0,
  ratingCount: 0,
  acceptancePct: null,
  onTimePct: null,
  ...m,
});

describe("pickTier", () => {
  it("gives the lowest tier to a new rider and lists what Silver needs", () => {
    const pick = pickTier(TIERS, metrics({ deliveries: 5 }));
    expect(pick.tier?.name).toBe("Bronze");
    expect(pick.next?.name).toBe("Silver");
    expect(pick.next?.needs).toEqual([
      { metric: "deliveries", have: 5, need: 30 },
      { metric: "rating", have: 0, need: 400 },
    ]);
  });

  it("picks the highest tier whose every minimum is met", () => {
    const pick = pickTier(TIERS, metrics({ deliveries: 80, ratingX100: 450, acceptancePct: 85, onTimePct: 95 }));
    expect(pick.tier?.name).toBe("Gold");
    expect(pick.next).toBeNull();
  });

  it("one missed minimum keeps the rider below that tier", () => {
    const pick = pickTier(TIERS, metrics({ deliveries: 80, ratingX100: 450, acceptancePct: 85, onTimePct: 85 }));
    expect(pick.tier?.name).toBe("Silver");
    expect(pick.next).toEqual({ name: "Gold", needs: [{ metric: "onTime", have: 85, need: 90 }] });
  });

  it("no offers / no promised orders count as 100 %", () => {
    expect(pickTier(TIERS, metrics({ deliveries: 30, ratingX100: 400 })).tier?.name).toBe("Silver");
  });

  it("no tier when even the first has a minimum not met", () => {
    const pick = pickTier(TIERS.slice(1), metrics({ deliveries: 3 }));
    expect(pick.tier).toBeNull();
    expect(pick.next?.name).toBe("Silver");
  });

  it("pct rounds and is null with nothing to measure", () => {
    expect(pct(2, 3)).toBe(67);
    expect(pct(0, 0)).toBeNull();
  });
});

describe("slot dates and times", () => {
  const slot = {
    startTime: "18:00",
    endTime: "21:00",
    daysOfWeek: [] as number[],
    validFrom: null as string | null,
    validTo: null as string | null,
    isActive: true,
    bookable: true,
  };

  it("works out IST instants", () => {
    expect(zonedInstant("2026-11-25", 18 * 60, TZ).toISOString()).toBe("2026-11-25T12:30:00.000Z");
    const w = slotWindow(slot, "2026-11-25", TZ);
    expect(w.start.toISOString()).toBe("2026-11-25T12:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-25T15:30:00.000Z");
  });

  it("a window ending before it starts runs past midnight", () => {
    const w = slotWindow({ startTime: "22:00", endTime: "02:00" }, "2026-11-25", TZ);
    expect(w.start.toISOString()).toBe("2026-11-25T16:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-25T20:30:00.000Z");
  });

  it("lists today and the next days in IST, even late in the UTC day", () => {
    // 20:00 UTC on 25 Nov is 01:30 IST on 26 Nov.
    expect(bookableDates(new Date("2026-11-25T20:00:00Z"), 3, TZ)).toEqual(["2026-11-26", "2026-11-27", "2026-11-28"]);
    expect(addDaysKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayOfKey("2026-11-25")).toBe(3); // Wednesday
  });

  it("respects weekdays, validity dates, active and bookable", () => {
    expect(slotRunsOn(slot, "2026-11-25")).toBe(true);
    expect(slotRunsOn({ ...slot, daysOfWeek: [0, 6] }, "2026-11-25")).toBe(false);
    expect(slotRunsOn({ ...slot, validFrom: "2026-11-26" }, "2026-11-25")).toBe(false);
    expect(slotRunsOn({ ...slot, validTo: "2026-11-24" }, "2026-11-25")).toBe(false);
    expect(slotRunsOn({ ...slot, bookable: false }, "2026-11-25")).toBe(false);
    expect(slotRunsOn({ ...slot, isActive: false }, "2026-11-25")).toBe(false);
  });

  it("cancel cut-off, booking until the end, reminder window", () => {
    const start = new Date("2026-11-25T12:30:00Z");
    expect(canCancel(start, new Date("2026-11-25T11:30:00Z"), 60)).toBe(true);
    expect(canCancel(start, new Date("2026-11-25T11:31:00Z"), 60)).toBe(false);
    expect(canBook(new Date("2026-11-25T15:30:00Z"), new Date("2026-11-25T15:29:00Z"))).toBe(true);
    expect(canBook(new Date("2026-11-25T15:30:00Z"), new Date("2026-11-25T15:30:00Z"))).toBe(false);
    expect(reminderDue(start, new Date("2026-11-25T12:15:00Z"), 15)).toBe(true);
    expect(reminderDue(start, new Date("2026-11-25T12:14:00Z"), 15)).toBe(false);
    expect(reminderDue(start, new Date("2026-11-25T12:30:00Z"), 15)).toBe(false);
  });

  it("describes the pay boost", () => {
    expect(slotBoostTags({ surgeMultiplierBp: 12000, peakBonusPaise: 2000, baseFeePaise: null, perKmFeePaise: 750, minEarningPaise: null })).toEqual([
      "×1.2 pay",
      "+₹20 per order",
      "₹7.50/km",
    ]);
    expect(slotBoostTags({ surgeMultiplierBp: 10000, peakBonusPaise: 0, baseFeePaise: null, perKmFeePaise: null, minEarningPaise: 0 })).toEqual([]);
  });
});

describe("referral", () => {
  const approvedAt = new Date("2026-11-01T06:00:00Z");
  const base = { approvedAt, withinDays: 30, deliveriesRequired: 20, deliveriesInWindow: 5, now: new Date("2026-11-11T06:00:00Z") };

  it("waits for approval before the window starts", () => {
    expect(referralState({ ...base, approvedAt: null }).state).toBe("WAITING_APPROVAL");
  });

  it("is pending inside the window with days left", () => {
    const s = referralState(base);
    expect(s.state).toBe("PENDING");
    expect(s.daysLeft).toBe(20);
    expect(s.deadline?.toISOString()).toBe("2026-12-01T06:00:00.000Z");
  });

  it("qualifies on reaching the target, even when checked after the window", () => {
    expect(referralState({ ...base, deliveriesInWindow: 20 }).state).toBe("QUALIFIED");
    expect(referralState({ ...base, deliveriesInWindow: 20, now: new Date("2026-12-05T00:00:00Z") }).state).toBe("QUALIFIED");
  });

  it("expires once the window has passed short of the target", () => {
    expect(referralState({ ...base, now: new Date("2026-12-01T06:00:01Z") }).state).toBe("EXPIRED");
    expect(referralState({ ...base, now: new Date("2026-12-01T06:00:00Z") }).state).toBe("PENDING");
  });

  it("codes look like GKR + 6 and are normalised", () => {
    expect(newReferralCode()).toMatch(/^GKR[A-HJKMNP-Z2-9]{6}$/);
    expect(normaliseReferralCode(" gkr-4k7 p2q ")).toBe("GKR4K7P2Q");
    expect(normaliseReferralCode("GK123")).toBeNull();
    expect(normaliseReferralCode(null)).toBeNull();
  });
});
