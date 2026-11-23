/**
 * Subscription plan rules (docs/subscription-plans-2026-11): pure functions —
 * a plan's own settings, a customer's schedule fitted to the plan, labels and
 * fixed-term end dates.
 */
import { describe, expect, it } from "vitest";

import {
  defaultPlanSchedule,
  fitScheduleToPlan,
  planRulesProblem,
  serviceDaysLabel,
  slotLabel,
  termEndDate,
} from "@/lib/subscription-plans";

const monToSat = { allowedFrequencies: ["DAILY", "WEEKLY"] as ("DAILY" | "WEEKLY" | "MONTHLY")[], serviceDays: [1, 2, 3, 4, 5, 6] };

describe("planRulesProblem — a shop's plan settings", () => {
  it("accepts a sensible plan", () => {
    expect(planRulesProblem({ ...monToSat, termDays: [7, 30], leadDays: 1 })).toBeNull();
  });
  it("refuses no frequency, no serving day, a bad term or lead", () => {
    expect(planRulesProblem({ allowedFrequencies: [], serviceDays: [1], termDays: [], leadDays: 1 })).toMatch(/at least one way/);
    expect(planRulesProblem({ ...monToSat, serviceDays: [], termDays: [], leadDays: 1 })).toMatch(/days this plan is delivered/);
    expect(planRulesProblem({ ...monToSat, serviceDays: [8], termDays: [], leadDays: 1 })).toMatch(/days this plan is delivered/);
    expect(planRulesProblem({ ...monToSat, termDays: [0], leadDays: 1 })).toMatch(/1 to 365/);
    expect(planRulesProblem({ ...monToSat, termDays: [], leadDays: 31 })).toMatch(/0 to 30/);
  });
});

describe("fitScheduleToPlan — the customer's choice within the plan", () => {
  it("'every delivery day' on a Mon–Sat plan becomes Mon–Sat", () => {
    expect(fitScheduleToPlan({ frequency: "DAILY", weekdays: [], monthDays: [] }, monToSat)).toEqual({
      schedule: { frequency: "WEEKLY", weekdays: [1, 2, 3, 4, 5, 6], monthDays: [] },
    });
  });
  it("'every day' on an every-day plan stays daily", () => {
    expect(fitScheduleToPlan({ frequency: "DAILY", weekdays: [], monthDays: [] }, { ...monToSat, serviceDays: [1, 2, 3, 4, 5, 6, 7] })).toEqual({
      schedule: { frequency: "DAILY", weekdays: [], monthDays: [] },
    });
  });
  it("keeps chosen weekdays the plan serves, refuses a day it does not", () => {
    expect(fitScheduleToPlan({ frequency: "WEEKLY", weekdays: [5, 1, 1], monthDays: [] }, monToSat)).toEqual({
      schedule: { frequency: "WEEKLY", weekdays: [1, 5], monthDays: [] },
    });
    expect(fitScheduleToPlan({ frequency: "WEEKLY", weekdays: [7], monthDays: [] }, monToSat)).toEqual({ problem: "Choose only days this plan is delivered." });
  });
  it("refuses a frequency the plan does not allow", () => {
    expect(fitScheduleToPlan({ frequency: "MONTHLY", weekdays: [], monthDays: [1] }, monToSat)).toEqual({
      problem: "This plan cannot be taken on days of the month.",
    });
    expect(
      fitScheduleToPlan({ frequency: "DAILY", weekdays: [], monthDays: [] }, { allowedFrequencies: ["WEEKLY"], serviceDays: [1, 2, 3, 4, 5, 6, 7] }),
    ).toEqual({ problem: "This plan cannot be taken every day." });
  });
  it("checks days of the month", () => {
    const monthly = { allowedFrequencies: ["MONTHLY"] as ("MONTHLY")[], serviceDays: [1, 2, 3, 4, 5, 6, 7] };
    expect(fitScheduleToPlan({ frequency: "MONTHLY", weekdays: [], monthDays: [15, 1] }, monthly)).toEqual({
      schedule: { frequency: "MONTHLY", weekdays: [], monthDays: [1, 15] },
    });
    expect(fitScheduleToPlan({ frequency: "MONTHLY", weekdays: [], monthDays: [30] }, monthly)).toEqual({ problem: "Choose days of the month between 1 and 28." });
  });
});

describe("defaults, labels, terms", () => {
  it("starts the form on the plan's first allowed schedule", () => {
    expect(defaultPlanSchedule(monToSat)).toEqual({ frequency: "WEEKLY", weekdays: [1, 2, 3, 4, 5, 6], monthDays: [] });
    expect(defaultPlanSchedule({ allowedFrequencies: ["MONTHLY"], serviceDays: [1, 2, 3, 4, 5, 6, 7] })).toEqual({ frequency: "MONTHLY", weekdays: [], monthDays: [1] });
  });
  it("labels serving days and slots", () => {
    expect(serviceDaysLabel([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(serviceDaysLabel([6, 1, 2, 3, 4, 5])).toBe("Mon–Sat");
    expect(serviceDaysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(slotLabel("LUNCH")).toBe("Lunch (12–2 pm)");
    expect(slotLabel("LUNCH", "12:30–2 pm")).toBe("Lunch (12:30–2 pm)");
    expect(slotLabel("ANYTIME")).toBe("Any time");
  });
  it("ends a fixed term on its last day, across a month end", () => {
    expect(termEndDate("2026-12-01", 30)).toBe("2026-12-30");
    expect(termEndDate("2026-11-25", 7)).toBe("2026-12-01");
    expect(termEndDate("2026-12-31", 1)).toBe("2026-12-31");
  });
});
