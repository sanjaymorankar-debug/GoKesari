/**
 * Pure opening-hours logic, split out from server/services/shops.ts so
 * client components can check whether a shop is open without pulling in
 * that file's database imports (postgres uses Node's `fs`, which breaks a
 * client bundle).
 */
import type { Shop } from "@/server/db/schema";

/**
 * Shop opening hours are Indian local time (IST, UTC+5:30, no daylight saving).
 * Evaluating them in the machine's own zone made the server (UTC) and the
 * customer's browser disagree, so a shop could look open to one and closed to
 * the other (and trigger a React hydration mismatch). Everything here works on
 * an IST-shifted clock, so server and browser always agree.
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface IstClock {
  /** 0 = Sunday. */
  day: number;
  minutes: number;
  /** Epoch ms of today's 00:00 IST. */
  midnightMs: number;
}

function istClock(now: Date): IstClock {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    midnightMs: Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS,
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function isShopOpenNow(shop: Pick<Shop, "openingHours">, now: Date = new Date()): boolean {
  const hours = shop.openingHours;
  if (!hours || hours.length === 0) return true; // unset means always open

  const clock = istClock(now);
  const today = hours.find((h) => h.day === clock.day);
  if (!today || today.closed) return false;

  return clock.minutes >= toMinutes(today.open) && clock.minutes <= toMinutes(today.close);
}

/**
 * When the shop next opens, or null when it is open now / never opens (no open
 * day configured). Looks up to a week ahead.
 */
export function nextOpeningAt(shop: Pick<Shop, "openingHours">, now: Date = new Date()): Date | null {
  const hours = shop.openingHours;
  if (!hours || hours.length === 0) return null;
  if (isShopOpenNow(shop, now)) return null;

  const clock = istClock(now);
  for (let offset = 0; offset <= 7; offset++) {
    const entry = hours.find((h) => h.day === (clock.day + offset) % 7);
    if (!entry || entry.closed) continue;
    const openMinutes = toMinutes(entry.open);
    if (offset === 0 && openMinutes <= clock.minutes) continue; // already past today's opening
    return new Date(clock.midnightMs + offset * DAY_MS + openMinutes * 60_000);
  }
  return null;
}

/** "Fri 9:00 AM" in IST — deterministic, so server and browser render the same text. */
export function formatShopTime(date: Date): string {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  const h = shifted.getUTCHours();
  const m = String(shifted.getUTCMinutes()).padStart(2, "0");
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${WEEKDAYS[shifted.getUTCDay()]} ${hour12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** "10 PM" / "9:30 PM" in IST, from an "HH:MM" opening-hours value. */
function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The shop's open/closed line for a card: "Open till 10 PM", "Open" (no
 * hours set, so always open), "Closed · opens Fri 9:00 AM" or "Closed".
 */
export function shopHoursLabel(shop: Pick<Shop, "openingHours">, now: Date = new Date()): string {
  const hours = shop.openingHours;
  if (!hours || hours.length === 0) return "Open";
  if (isShopOpenNow(shop, now)) {
    const today = hours.find((h) => h.day === istClock(now).day);
    return today ? `Open till ${formatClock(today.close)}` : "Open";
  }
  const next = nextOpeningAt(shop, now);
  return next ? `Closed · opens ${formatShopTime(next)}` : "Closed";
}
