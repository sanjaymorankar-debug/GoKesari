/**
 * Date handling for delivery scheduling.
 *
 * Deliveries are calendar-day concepts, not instants. They are stored as
 * `YYYY-MM-DD` strings in `date` columns and always interpreted in the
 * application timezone (IST by default) so a customer in Pune and a server in
 * UTC agree on what "tomorrow" means.
 */

export type IsoDate = string; // YYYY-MM-DD

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  return ISO_DATE_RE.test(value);
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new RangeError(`Expected YYYY-MM-DD, received "${value}"`);
  }
  return value;
}

/** Current calendar date in the given IANA timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return formatInTimeZone(now, timeZone);
}

/** Current hour (0-23) in the given timezone — used for the delivery cutoff. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number.parseInt(hour, 10);
}

function formatInTimeZone(date: Date, timeZone: string): IsoDate {
  // en-CA yields YYYY-MM-DD, which is exactly the storage format.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number);
  // UTC arithmetic avoids DST shifting the result by a day.
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const toUtc = (d: IsoDate) => {
    const [y, m, day] = assertIsoDate(d).split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  // Lexicographic comparison is chronological for zero-padded ISO dates.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isOnOrAfter(a: IsoDate, b: IsoDate): boolean {
  return compareDates(a, b) >= 0;
}

export function isOnOrBefore(a: IsoDate, b: IsoDate): boolean {
  return compareDates(a, b) <= 0;
}

/** Inclusive on both ends. */
export function isWithin(date: IsoDate, from: IsoDate, until: IsoDate): boolean {
  return isOnOrAfter(date, from) && isOnOrBefore(date, until);
}

/** Inclusive list of dates from `start` for `count` days. */
export function dateRange(start: IsoDate, count: number): IsoDate[] {
  if (count < 0) throw new RangeError("count must not be negative");
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: IsoDate): number {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sunday = 0
  return day === 0 ? 7 : day;
}

export function formatDisplayDate(date: IsoDate): string {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "20 Aug" — used in the subscription calendar. */
export function formatShortDate(date: IsoDate): string {
  assertIsoDate(date);
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
