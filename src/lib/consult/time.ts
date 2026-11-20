/**
 * Consultant appointments: India Standard Time helpers. Times are stored in
 * UTC (timestamptz) and always shown in IST. IST is UTC+05:30 all year (no
 * daylight saving), so plain arithmetic is exact. Pure — client and server.
 */

export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** "2026-11-20" — the IST calendar day of an instant. */
export function istDateKey(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The UTC instant of 00:00 IST on a day. */
export function istMidnight(dateKey: string): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - IST_OFFSET_MS);
}

/** The UTC instant of a day plus minutes after midnight IST. */
export function istAt(dateKey: string, minuteOfDay: number): Date {
  return new Date(istMidnight(dateKey).getTime() + minuteOfDay * 60_000);
}

/** 0 = Sunday … 6 = Saturday, for an IST day. */
export function istWeekday(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** Minutes after midnight IST of an instant. */
export function istMinuteOfDay(at: Date): number {
  const ms = (at.getTime() + IST_OFFSET_MS) % DAY_MS;
  return Math.floor((ms < 0 ? ms + DAY_MS : ms) / 60_000);
}

export function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every IST day from `from` to `to` inclusive (at most `max`). */
export function dateKeysBetween(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "10:30" → 630; null when malformed. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** 630 → "10:30". */
export function clock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 630 → "10:30 AM", 1020 → "5:00 PM". */
export function clock12(minuteOfDay: number): string {
  const h24 = Math.floor(minuteOfDay / 60) % 24;
  const m = minuteOfDay % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Fri, 20-Nov-2026" for an IST day. */
export function formatDateKey(dateKey: string): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  return `${DAYS[istWeekday(dateKey)]}, ${String(d).padStart(2, "0")}-${MONTHS[mo - 1]}-${y}`;
}

/** "20-Nov-2026, 10.30 IST" — the owner's report format (DD-Mmm-YYYY, hh.mm IST). */
export function formatIst(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const key = istDateKey(d);
  const [y, mo, day] = key.split("-").map(Number);
  const mins = istMinuteOfDay(d);
  return `${String(day).padStart(2, "0")}-${MONTHS[mo - 1]}-${y}, ${String(Math.floor(mins / 60)).padStart(2, "0")}.${String(mins % 60).padStart(2, "0")} IST`;
}

/** "Fri, 20-Nov-2026 · 10:30 AM" — for customers and consultants. */
export function formatSlot(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return `${formatDateKey(istDateKey(d))} · ${clock12(istMinuteOfDay(d))}`;
}

/** Indian financial year of an instant: "2026-27". */
export function financialYear(at: Date): string {
  const key = istDateKey(at);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Monday of the IST week containing a day. */
export function weekStart(dateKey: string): string {
  const dow = istWeekday(dateKey);
  return addDays(dateKey, dow === 0 ? -6 : 1 - dow);
}

export function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

export function monthEnd(dateKey: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}
