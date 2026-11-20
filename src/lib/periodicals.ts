/**
 * Newspapers and periodicals (docs/newspaper-subscriptions-2026-11) —
 * client-safe: the subscription pages and the server share these rules.
 *
 * A periodical is an ordinary catalogue product sold by the copy, plus a
 * `periodical_titles` row saying what it is and when it comes out. The
 * publication schedule only pre-fills the subscription; the customer's own
 * schedule (every day, chosen weekdays, chosen days of the month) is what
 * the engine follows.
 */

export const PERIODICAL_KINDS = ["NEWSPAPER", "MAGAZINE"] as const;
export type PeriodicalKind = (typeof PERIODICAL_KINDS)[number];

export const PERIODICAL_PUBLICATIONS = ["DAILY", "WEEKLY", "FORTNIGHTLY", "MONTHLY"] as const;
export type PeriodicalPublication = (typeof PERIODICAL_PUBLICATIONS)[number];

/** The shop type a newspaper vendor registers as. */
export const NEWSPAPER_VENDOR_SHOP_TYPE = "NEWSPAPER_VENDOR";

/** Slugs of the two catalogue categories that hold every title (migration 0152). */
export const PERIODICAL_CATEGORY_SLUGS = {
  NEWSPAPER: "newspapers",
  MAGAZINE: "magazines-periodicals",
} as const satisfies Record<PeriodicalKind, string>;

export const PERIODICAL_KIND_LABELS: Record<PeriodicalKind, string> = {
  NEWSPAPER: "Newspaper",
  MAGAZINE: "Magazine / periodical",
};

export const PUBLICATION_LABELS: Record<PeriodicalPublication, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  FORTNIGHTLY: "Fortnightly",
  MONTHLY: "Monthly",
};

/** Subscription frequencies the engine understands. */
export type SubscriptionFrequency = "DAILY" | "WEEKLY" | "MONTHLY";

/** Days of the month a MONTHLY subscription may use — 1 to 28, so every month has them. */
export const MONTH_DAY_MIN = 1;
export const MONTH_DAY_MAX = 28;

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface SubscriptionSchedule {
  frequency: SubscriptionFrequency;
  /** ISO weekdays 1–7, for WEEKLY. */
  weekdays: number[];
  /** Days of the month 1–28, for MONTHLY. */
  monthDays: number[];
}

/** The details of a title that decide its default schedule. */
export interface PeriodicalScheduleSource {
  kind: PeriodicalKind;
  publication: PeriodicalPublication;
  issueWeekday: number | null;
  issueMonthDays: number[];
}

/**
 * The schedule a new subscription to this title starts with: a daily paper
 * every day, a weekly on its issue day (Sunday if unknown), a fortnightly on
 * its issue days (1st and 15th if unknown), a monthly on its issue day (1st
 * if unknown).
 */
export function defaultScheduleFor(title: PeriodicalScheduleSource | null, fallbackKind: PeriodicalKind = "NEWSPAPER"): SubscriptionSchedule {
  const publication = title?.publication ?? (fallbackKind === "MAGAZINE" ? "MONTHLY" : "DAILY");
  const validDays = (title?.issueMonthDays ?? []).filter(isValidMonthDay);
  switch (publication) {
    case "DAILY":
      return { frequency: "DAILY", weekdays: [], monthDays: [] };
    case "WEEKLY":
      return { frequency: "WEEKLY", weekdays: [isValidWeekday(title?.issueWeekday) ? title!.issueWeekday! : 7], monthDays: [] };
    case "FORTNIGHTLY":
      return { frequency: "MONTHLY", weekdays: [], monthDays: validDays.length > 0 ? sortedUnique(validDays) : [1, 15] };
    case "MONTHLY":
      return { frequency: "MONTHLY", weekdays: [], monthDays: validDays.length > 0 ? sortedUnique(validDays) : [1] };
  }
}

export function isValidWeekday(day: unknown): day is number {
  return Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7;
}

export function isValidMonthDay(day: unknown): day is number {
  return Number.isInteger(day) && (day as number) >= MONTH_DAY_MIN && (day as number) <= MONTH_DAY_MAX;
}

export function sortedUnique(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Why a schedule cannot be used, or null when it can. The server refuses with the same words. */
export function scheduleProblem(schedule: SubscriptionSchedule): string | null {
  if (schedule.frequency === "WEEKLY") {
    if (schedule.weekdays.length === 0) return "Choose at least one delivery day of the week.";
    if (!schedule.weekdays.every(isValidWeekday)) return "Delivery days of the week must be Monday to Sunday.";
  }
  if (schedule.frequency === "MONTHLY") {
    if (schedule.monthDays.length === 0) return "Choose at least one day of the month.";
    if (!schedule.monthDays.every(isValidMonthDay)) return `Days of the month must be between ${MONTH_DAY_MIN} and ${MONTH_DAY_MAX}.`;
  }
  return null;
}

function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** "Every day", "Mon, Thu", "Sun", "1st and 15th of the month". */
export function scheduleLabel(schedule: Pick<SubscriptionSchedule, "frequency"> & Partial<SubscriptionSchedule>): string {
  const weekdays = schedule.weekdays ?? [];
  const monthDays = schedule.monthDays ?? [];
  if (schedule.frequency === "DAILY" || (schedule.frequency === "WEEKLY" && weekdays.length === 7)) return "Every day";
  if (schedule.frequency === "WEEKLY") {
    return sortedUnique(weekdays).map((d) => WEEKDAY_SHORT[d - 1] ?? String(d)).join(", ");
  }
  const days = sortedUnique(monthDays).map(ordinal);
  if (days.length === 0) return "Monthly";
  const list = days.length === 1 ? days[0] : `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
  return `${list} of the month`;
}

/**
 * Deliveries a schedule makes in an average 30 days — for the cost estimate
 * shown before submitting. MONTHLY: each chosen day once a month.
 */
export function deliveriesIn30Days(schedule: SubscriptionSchedule): number {
  if (schedule.frequency === "DAILY") return 30;
  if (schedule.frequency === "WEEKLY") return Math.round((sortedUnique(schedule.weekdays).length / 7) * 30);
  return sortedUnique(schedule.monthDays).length;
}

/** "copy" / "copies" — newspapers are counted in copies, not pieces. */
export function copiesLabel(count: number): string {
  return `${count} ${count === 1 ? "copy" : "copies"}`;
}
