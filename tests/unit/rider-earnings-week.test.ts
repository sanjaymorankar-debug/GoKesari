/** Rider App v2 — the Mon–Sun (IST) earnings week maths (src/lib/rider-week.ts). */
import { describe, expect, it } from "vitest";

import { addDays, mondayOf, parseDateKey, summariseWeek, weekWindow, type WeekEarningRow } from "@/lib/rider-week";

const row = (over: Partial<WeekEarningRow>): WeekEarningRow => ({
  id: "e",
  dateKey: "2026-11-23",
  createdAt: new Date("2026-11-23T06:00:00Z"),
  orderNumber: "GK-1",
  isReturnPickup: false,
  basePaise: 2000,
  distancePaise: 1000,
  orderComponentPaise: 0,
  slotIncentivePaise: 0,
  minTopUpPaise: 0,
  orderIncentivePaise: 0,
  otherIncentivePaise: 0,
  deductionsPaise: 0,
  totalPaise: 3000,
  quotePaise: null,
  payoutStatus: null,
  ...over,
});

describe("rider earnings week", () => {
  it("parses only real calendar dates", () => {
    expect(parseDateKey("2026-11-25")).toBe("2026-11-25");
    expect(parseDateKey("2026-02-30")).toBeNull();
    expect(parseDateKey("25-11-2026")).toBeNull();
    expect(parseDateKey(null)).toBeNull();
  });

  it("snaps any day to its Monday, across months and years", () => {
    expect(mondayOf("2026-11-25")).toBe("2026-11-23"); // Wednesday
    expect(mondayOf("2026-11-23")).toBe("2026-11-23"); // Monday itself
    expect(mondayOf("2026-11-29")).toBe("2026-11-23"); // Sunday ends the Mon–Sun week
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("builds the week window with prev / next and never goes into the future", () => {
    const current = weekWindow(null, "2026-11-25");
    expect(current).toMatchObject({ start: "2026-11-23", end: "2026-11-29", prevStart: "2026-11-16", nextStart: null, isCurrent: true });
    expect(current.days).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);

    const past = weekWindow("2026-11-18", "2026-11-25");
    expect(past).toMatchObject({ start: "2026-11-16", end: "2026-11-22", nextStart: "2026-11-23", isCurrent: false });

    expect(weekWindow("2027-01-05", "2026-11-25").start).toBe("2026-11-23");
    expect(weekWindow("garbage", "2026-11-25").start).toBe("2026-11-23");
  });

  it("totals the week, the seven days and the chips; tips are 0; rows outside the week are ignored", () => {
    const week = weekWindow(null, "2026-11-25");
    const summary = summariseWeek(
      week,
      [
        row({ id: "a", dateKey: "2026-11-23", totalPaise: 3000 }),
        row({
          id: "b",
          dateKey: "2026-11-25",
          createdAt: new Date("2026-11-25T08:00:00Z"),
          slotIncentivePaise: 500,
          otherIncentivePaise: 1000,
          deductionsPaise: 200,
          totalPaise: 4300,
          quotePaise: 3500,
        }),
        row({ id: "old", dateKey: "2026-11-22", totalPaise: 99_999 }),
      ],
      [{ earningId: "b", component: "OTHER_INCENTIVE", amountPaise: 1000, description: "Daily target" }],
    );
    expect(summary.totalPaise).toBe(7300);
    expect(summary.trips).toBe(2);
    expect(summary.days.map((d) => d.totalPaise)).toEqual([3000, 0, 4300, 0, 0, 0, 0]);
    expect(summary.chips).toEqual({ tripPaise: 6000, incentivesPaise: 1500, tipsPaise: 0, deductionsPaise: -200 });
    expect(summary.orders.map((o) => o.earningId)).toEqual(["b", "a"]);
    expect(summary.orders[0].quotePaise).toBe(3500);
    expect(summary.orders[0].lines).toEqual([{ component: "OTHER_INCENTIVE", amountPaise: 1000, description: "Daily target" }]);
    // No ledger lines: the stored breakdown stands in.
    expect(summary.orders[1].lines).toEqual([
      { component: "BASE", amountPaise: 2000, description: "" },
      { component: "DISTANCE", amountPaise: 1000, description: "" },
    ]);
    expect(summary.orders[1].payoutStatus).toBe("UNPAID");
  });
});
