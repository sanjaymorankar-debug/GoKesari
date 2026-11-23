/**
 * Subscription plans (docs/subscription-plans-2026-11) — client-safe rules
 * shared by Seller Central, the customer pages and the server.
 *
 * A plan is a shop's offer to deliver one of its products on repeat: what
 * kind it is, at what slot, on which days, which schedules a customer may
 * choose, an optional subscriber price, optional fixed terms and how soon a
 * subscription may start. The engine (services/subscriptions.ts) then runs a
 * plan subscription like any other.
 */
import {
  isValidMonthDay,
  isValidWeekday,
  sortedUnique,
  type SubscriptionFrequency,
  type SubscriptionSchedule,
} from "./periodicals";

export const PLAN_KINDS = ["MEAL", "NEWSPAPER", "MILK_DAIRY", "BAKERY", "FLOWERS_PUJA", "WATER", "FRUITS_VEG", "OTHER"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_KIND_LABELS: Record<PlanKind, string> = {
  MEAL: "Meals & tiffin",
  NEWSPAPER: "Newspapers & magazines",
  MILK_DAIRY: "Milk & dairy",
  BAKERY: "Bakery",
  FLOWERS_PUJA: "Flowers & puja",
  WATER: "Water",
  FRUITS_VEG: "Fruit & vegetables",
  OTHER: "Other",
};

export const PLAN_SLOTS = ["EARLY_MORNING", "BREAKFAST", "MORNING", "LUNCH", "SNACKS", "EVENING", "DINNER", "ANYTIME"] as const;
export type PlanSlot = (typeof PLAN_SLOTS)[number];

/** Label and the usual window, shown when the shop has not typed its own. */
export const PLAN_SLOT_LABELS: Record<PlanSlot, { label: string; window: string | null }> = {
  EARLY_MORNING: { label: "Early morning", window: "5–7 am" },
  BREAKFAST: { label: "Breakfast", window: "7–9 am" },
  MORNING: { label: "Morning", window: "9 am–12 pm" },
  LUNCH: { label: "Lunch", window: "12–2 pm" },
  SNACKS: { label: "Evening snacks", window: "4–6 pm" },
  EVENING: { label: "Evening", window: "5–8 pm" },
  DINNER: { label: "Dinner", window: "7–9 pm" },
  ANYTIME: { label: "Any time", window: null },
};

/** "Lunch (12:30–2 pm)" — the shop's own window wins over the usual one. */
export function slotLabel(slot: PlanSlot, window?: string | null): string {
  const s = PLAN_SLOT_LABELS[slot];
  const w = window?.trim() || s.window;
  return w ? `${s.label} (${w})` : s.label;
}

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const PLAN_MAX_TERM_DAYS = 365;
export const PLAN_MAX_LEAD_DAYS = 30;

/** The parts of a plan the customer's choices are checked against. */
export interface PlanRules {
  allowedFrequencies: SubscriptionFrequency[];
  /** ISO weekdays the shop delivers this plan (1 Mon … 7 Sun). */
  serviceDays: number[];
  /** Fixed lengths in days the customer must pick from; empty = open-ended or own end date. */
  termDays: number[];
  /** Earliest start = today + leadDays. */
  leadDays: number;
}

/** Why a plan's own settings are unusable, or null. Seller Central shows the same words. */
export function planRulesProblem(rules: PlanRules): string | null {
  if (rules.allowedFrequencies.length === 0) return "Allow at least one way to subscribe (every day, days of the week or days of the month).";
  if (rules.serviceDays.length === 0 || !rules.serviceDays.every(isValidWeekday)) return "Choose the days this plan is delivered.";
  if (!rules.termDays.every((d) => Number.isInteger(d) && d >= 1 && d <= PLAN_MAX_TERM_DAYS)) {
    return `Each fixed term must be 1 to ${PLAN_MAX_TERM_DAYS} days.`;
  }
  if (!Number.isInteger(rules.leadDays) || rules.leadDays < 0 || rules.leadDays > PLAN_MAX_LEAD_DAYS) {
    return `Days before the first delivery must be 0 to ${PLAN_MAX_LEAD_DAYS}.`;
  }
  return null;
}

/**
 * The customer's schedule, fitted to the plan: "every day" on a plan that
 * does not serve every day becomes its serving days. Returns the schedule to
 * store, or the reason it cannot be used.
 */
export function fitScheduleToPlan(
  schedule: SubscriptionSchedule,
  rules: Pick<PlanRules, "allowedFrequencies" | "serviceDays">,
): { schedule: SubscriptionSchedule } | { problem: string } {
  const serving = sortedUnique(rules.serviceDays.filter(isValidWeekday));
  const everyDay = serving.length === 7;
  // "Every day" is offered whenever the plan allows DAILY; on a part-week plan it means its serving days.
  if (schedule.frequency === "DAILY") {
    if (!rules.allowedFrequencies.includes("DAILY")) return { problem: "This plan cannot be taken every day." };
    return { schedule: everyDay ? { frequency: "DAILY", weekdays: [], monthDays: [] } : { frequency: "WEEKLY", weekdays: serving, monthDays: [] } };
  }
  if (!rules.allowedFrequencies.includes(schedule.frequency)) {
    return { problem: schedule.frequency === "WEEKLY" ? "This plan cannot be taken on chosen weekdays." : "This plan cannot be taken on days of the month." };
  }
  if (schedule.frequency === "WEEKLY") {
    const days = sortedUnique(schedule.weekdays);
    if (days.length === 0) return { problem: "Choose at least one delivery day of the week." };
    const off = days.filter((d) => !serving.includes(d));
    if (off.length > 0) return { problem: "Choose only days this plan is delivered." };
    return { schedule: { frequency: "WEEKLY", weekdays: days, monthDays: [] } };
  }
  const days = sortedUnique(schedule.monthDays);
  if (days.length === 0 || !days.every(isValidMonthDay)) return { problem: "Choose days of the month between 1 and 28." };
  return { schedule: { frequency: "MONTHLY", weekdays: [], monthDays: days } };
}

/** The schedule the subscribe form starts with: the first frequency the plan allows, on its serving days. */
export function defaultPlanSchedule(rules: Pick<PlanRules, "allowedFrequencies" | "serviceDays">): SubscriptionSchedule {
  const serving = sortedUnique(rules.serviceDays.filter(isValidWeekday));
  if (rules.allowedFrequencies.includes("DAILY")) {
    return serving.length === 7 ? { frequency: "DAILY", weekdays: [], monthDays: [] } : { frequency: "WEEKLY", weekdays: serving, monthDays: [] };
  }
  if (rules.allowedFrequencies.includes("WEEKLY")) return { frequency: "WEEKLY", weekdays: serving, monthDays: [] };
  return { frequency: "MONTHLY", weekdays: [], monthDays: [1] };
}

/** "Mon–Sat", "Every day", "Mon, Wed, Fri". */
export function serviceDaysLabel(days: number[]): string {
  const d = sortedUnique(days.filter(isValidWeekday));
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (d.length === 7) return "Every day";
  const run = d.length > 2 && d.every((day, i) => i === 0 || day === d[i - 1] + 1);
  if (run) return `${names[d[0] - 1]}–${names[d[d.length - 1] - 1]}`;
  return d.map((day) => names[day - 1]).join(", ");
}

/** The last delivery date of a fixed term starting on `start` (inclusive). */
export function termEndDate(start: string, termDays: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1, d + termDays - 1));
  return end.toISOString().slice(0, 10);
}
