/**
 * Working-hours arithmetic in India time (docs/flows-v3/wave1.md, F17 first-response deadline).
 *
 * A calendar is a set of weekdays (0 = Sunday … 6 = Saturday) and one daily window [startHour, endHour) in IST.
 * addWorkingHours(from, n) returns the instant n working hours after `from`: time outside the window does not
 * count, and a start outside the window begins at the next opening. IST has no daylight saving, so a fixed
 * +05:30 offset is exact. Public holidays are not modelled.
 */
export interface WorkingCalendar {
  workingDays: readonly number[];
  startHour: number;
  endHour: number;
}

const IST_OFFSET_MS = 330 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Adds `hours` working hours to `from`. A calendar with no working time returns `from` plus calendar hours. */
export function addWorkingHours(from: Date, hours: number, calendar: WorkingCalendar): Date {
  const start = Math.max(0, Math.min(23, calendar.startHour));
  const end = Math.max(start + 1, Math.min(24, calendar.endHour));
  const days = new Set(calendar.workingDays.filter((d) => d >= 0 && d <= 6));
  if (days.size === 0 || hours <= 0) return new Date(from.getTime() + Math.max(0, hours) * HOUR_MS);

  let remaining = hours * HOUR_MS;
  // Work in "IST wall-clock" milliseconds (UTC epoch shifted by +05:30), then shift back.
  let t = from.getTime() + IST_OFFSET_MS;
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    const open = dayStart + start * HOUR_MS;
    const close = dayStart + end * HOUR_MS;
    if (!days.has(weekday) || t >= close) {
      t = dayStart + DAY_MS;
      continue;
    }
    if (t < open) t = open;
    const available = close - t;
    if (remaining <= available) {
      t += remaining;
      remaining = 0;
    } else {
      remaining -= available;
      t = dayStart + DAY_MS;
    }
  }
  return new Date(t - IST_OFFSET_MS);
}
