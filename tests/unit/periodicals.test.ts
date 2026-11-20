/**
 * Newspaper and periodical schedules (docs/newspaper-subscriptions-2026-11).
 * Pure rules: the month-day schedule, the default schedule per title, labels
 * and the 30-day delivery count the cost estimate uses.
 */
import { describe, expect, it } from "vitest";

import {
  defaultScheduleFor,
  deliveriesIn30Days,
  scheduleLabel,
  scheduleProblem,
} from "@/lib/periodicals";
import { dayOfMonth, nextDeliveryDate, resolveDelivery, type ScheduleInput } from "@/server/services/subscriptions";

const monthly: ScheduleInput = {
  status: "ACTIVE",
  frequency: "MONTHLY",
  weekdays: [],
  monthDays: [1, 15],
  quantityMilli: 1000,
  startDate: "2026-12-01",
  endDate: null,
  pauseFrom: null,
  pauseUntil: null,
};

describe("resolveDelivery — days of the month (MONTHLY)", () => {
  it("delivers on each chosen day of the month", () => {
    expect(resolveDelivery(monthly, "2026-12-01")).toEqual({ delivers: true, quantityMilli: 1000, reason: "STANDARD" });
    expect(resolveDelivery(monthly, "2026-12-15").delivers).toBe(true);
    expect(resolveDelivery(monthly, "2027-01-01").delivers).toBe(true);
  });

  it("does not deliver on the other days", () => {
    expect(resolveDelivery(monthly, "2026-12-02")).toEqual({ delivers: false, reason: "NOT_SCHEDULED_DAY" });
    expect(resolveDelivery(monthly, "2026-12-31")).toEqual({ delivers: false, reason: "NOT_SCHEDULED_DAY" });
  });

  it("still obeys the pause window and an override", () => {
    expect(resolveDelivery({ ...monthly, pauseFrom: "2026-12-10", pauseUntil: "2026-12-20" }, "2026-12-15").delivers).toBe(false);
    expect(resolveDelivery(monthly, "2026-12-15", { type: "QUANTITY", quantityMilli: 2000 })).toEqual({
      delivers: true,
      quantityMilli: 2000,
      reason: "OVERRIDE",
    });
    // An override never creates a delivery on an unscheduled day.
    expect(resolveDelivery(monthly, "2026-12-16", { type: "QUANTITY", quantityMilli: 2000 }).delivers).toBe(false);
  });

  it("finds the next delivery across a month end", () => {
    expect(nextDeliveryDate(monthly, "2026-12-16")).toBe("2027-01-01");
    expect(nextDeliveryDate({ ...monthly, monthDays: [28] }, "2027-01-29")).toBe("2027-02-28");
  });

  it("leaves daily and weekly schedules exactly as before (no monthDays)", () => {
    const daily: ScheduleInput = { ...monthly, frequency: "DAILY", monthDays: undefined };
    expect(resolveDelivery(daily, "2026-12-02").delivers).toBe(true);
    const weekly: ScheduleInput = { ...monthly, frequency: "WEEKLY", weekdays: [7], monthDays: undefined };
    expect(resolveDelivery(weekly, "2026-12-06").delivers).toBe(true); // a Sunday
    expect(resolveDelivery(weekly, "2026-12-07").delivers).toBe(false);
  });

  it("reads the day of the month from an ISO date", () => {
    expect(dayOfMonth("2026-12-09")).toBe(9);
    expect(dayOfMonth("2026-02-28")).toBe(28);
  });
});

describe("defaultScheduleFor — what a new subscription to a title starts with", () => {
  it("daily paper: every day", () => {
    expect(defaultScheduleFor({ kind: "NEWSPAPER", publication: "DAILY", issueWeekday: null, issueMonthDays: [] })).toEqual({
      frequency: "DAILY",
      weekdays: [],
      monthDays: [],
    });
  });

  it("weekly: its issue day, Sunday when unknown", () => {
    expect(defaultScheduleFor({ kind: "MAGAZINE", publication: "WEEKLY", issueWeekday: 3, issueMonthDays: [] }).weekdays).toEqual([3]);
    expect(defaultScheduleFor({ kind: "MAGAZINE", publication: "WEEKLY", issueWeekday: null, issueMonthDays: [] })).toEqual({
      frequency: "WEEKLY",
      weekdays: [7],
      monthDays: [],
    });
  });

  it("fortnightly: 1st and 15th unless the title says otherwise", () => {
    expect(defaultScheduleFor({ kind: "MAGAZINE", publication: "FORTNIGHTLY", issueWeekday: null, issueMonthDays: [] })).toEqual({
      frequency: "MONTHLY",
      weekdays: [],
      monthDays: [1, 15],
    });
    expect(
      defaultScheduleFor({ kind: "MAGAZINE", publication: "FORTNIGHTLY", issueWeekday: null, issueMonthDays: [16, 1, 1] }).monthDays,
    ).toEqual([1, 16]);
  });

  it("monthly: the 1st, ignoring days a month may not have", () => {
    expect(defaultScheduleFor({ kind: "MAGAZINE", publication: "MONTHLY", issueWeekday: null, issueMonthDays: [31] }).monthDays).toEqual([1]);
  });

  it("a title with no details: newspapers daily, magazines monthly", () => {
    expect(defaultScheduleFor(null, "NEWSPAPER").frequency).toBe("DAILY");
    expect(defaultScheduleFor(null, "MAGAZINE")).toEqual({ frequency: "MONTHLY", weekdays: [], monthDays: [1] });
  });
});

describe("scheduleProblem, scheduleLabel, deliveriesIn30Days", () => {
  it("refuses an empty or out-of-range schedule", () => {
    expect(scheduleProblem({ frequency: "WEEKLY", weekdays: [], monthDays: [] })).toMatch(/day of the week/);
    expect(scheduleProblem({ frequency: "MONTHLY", weekdays: [], monthDays: [] })).toMatch(/day of the month/);
    expect(scheduleProblem({ frequency: "MONTHLY", weekdays: [], monthDays: [29] })).toMatch(/between 1 and 28/);
    expect(scheduleProblem({ frequency: "DAILY", weekdays: [], monthDays: [] })).toBeNull();
    expect(scheduleProblem({ frequency: "MONTHLY", weekdays: [], monthDays: [1, 28] })).toBeNull();
  });

  it("labels each kind of schedule", () => {
    expect(scheduleLabel({ frequency: "DAILY" })).toBe("Every day");
    expect(scheduleLabel({ frequency: "WEEKLY", weekdays: [7] })).toBe("Sun");
    expect(scheduleLabel({ frequency: "WEEKLY", weekdays: [4, 1] })).toBe("Mon, Thu");
    expect(scheduleLabel({ frequency: "MONTHLY", monthDays: [1] })).toBe("1st of the month");
    expect(scheduleLabel({ frequency: "MONTHLY", monthDays: [15, 1] })).toBe("1st and 15th of the month");
    expect(scheduleLabel({ frequency: "MONTHLY", monthDays: [2, 3, 22] })).toBe("2nd, 3rd and 22nd of the month");
    expect(scheduleLabel({ frequency: "MONTHLY", monthDays: [11, 12, 13] })).toBe("11th, 12th and 13th of the month");
  });

  it("counts deliveries in 30 days", () => {
    expect(deliveriesIn30Days({ frequency: "DAILY", weekdays: [], monthDays: [] })).toBe(30);
    expect(deliveriesIn30Days({ frequency: "WEEKLY", weekdays: [7], monthDays: [] })).toBe(4);
    expect(deliveriesIn30Days({ frequency: "MONTHLY", weekdays: [], monthDays: [1, 15] })).toBe(2);
  });
});
