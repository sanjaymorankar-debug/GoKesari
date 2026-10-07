/**
 * GS-027 scheduled delivery slots — client-safe helpers.
 *
 * A slot is identified by "YYYY-MM-DD@HH:MM" (its IST start); its end is the
 * start plus the slot length (rule scheduledSlots.slotMinutes). Times are IST,
 * like shop opening hours (lib/shop-hours.ts), so server and browser agree.
 */
const IST_OFFSET_MS = 330 * 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function scheduledSlotKey(date: string, startMinutes: number): string {
  const h = String(Math.floor(startMinutes / 60)).padStart(2, "0");
  const m = String(startMinutes % 60).padStart(2, "0");
  return `${date}@${h}:${m}`;
}

export function parseScheduledSlotKey(key: string): { date: string; startMinutes: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})$/.exec(key);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes >= 24 * 60) return null;
  return { date: match[1], startMinutes: minutes };
}

/** Epoch ms of IST midnight at the start of `date`. */
export function istMidnightMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}

function istParts(at: Date) {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { day: shifted.getUTCDay(), date: shifted.getUTCDate(), month: shifted.getUTCMonth(), h: shifted.getUTCHours(), m: shifted.getUTCMinutes() };
}

function clock(h: number, m: number): string {
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}` : `${hour12}:${String(m).padStart(2, "0")}`;
}

/** "Tue 7 Oct, 2–4 pm" (IST). */
export function formatScheduledSlot(start: Date | string, end: Date | string): string {
  const s = istParts(new Date(start));
  const e = istParts(new Date(end));
  const sameHalf = s.h < 12 === e.h < 12;
  const startText = `${clock(s.h, s.m)}${sameHalf ? "" : s.h < 12 ? " am" : " pm"}`;
  const endText = `${clock(e.h, e.m)} ${e.h < 12 ? "am" : "pm"}`;
  return `${WEEKDAYS[s.day]} ${s.date} ${MONTHS[s.month]}, ${startText}–${endText}`;
}

/** "Tue 7 Oct" for a YYYY-MM-DD date. */
export function formatSlotDay(date: string): string {
  const p = istParts(new Date(istMidnightMs(date)));
  return `${WEEKDAYS[p.day]} ${p.date} ${MONTHS[p.month]}`;
}

/** "2–4 pm" for a slot (IST), without the day. */
export function formatSlotTime(start: Date | string, end: Date | string): string {
  return formatScheduledSlot(start, end).split(", ")[1];
}
