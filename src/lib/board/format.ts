/**
 * Number formatting for the Tile Board's badges. Pure — no server imports.
 *
 * A badge is shown only for a figure that was actually read: null, undefined,
 * NaN or a negative number (a failed or nonsensical read) gives no badge,
 * never a made-up or zero one.
 */

/**
 * Short form of a count for a badge: 7, 128, 9.6k, 17.9k, 312k, 1.2L, 3.4Cr.
 * Returns null when there is nothing to show — no figure, or zero unless
 * `showZero` is set (an empty queue needs no badge; a total like "Societies"
 * may still want to say 0).
 */
export function formatCount(value: number | null | undefined, options: { showZero?: boolean } = {}): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const n = Math.floor(value);
  if (n === 0) return options.showZero ? "0" : null;
  if (n < 1000) return String(n);
  if (n < 100_000) return `${trimDecimal(n / 1000)}k`;
  if (n < 10_000_000) return `${trimDecimal(n / 100_000)}L`;
  return `${trimDecimal(n / 10_000_000)}Cr`;
}

/** One decimal place, rounded down so 9,990 never reads as "10k", and no trailing ".0". */
function trimDecimal(x: number): string {
  const floored = Math.floor(x * 10) / 10;
  return floored >= 100 ? String(Math.floor(floored)) : floored.toFixed(1).replace(/\.0$/, "");
}

/** Full number for a screen-reader label beside the short badge ("17,900"). */
export function countForReader(value: number): string {
  return new Intl.NumberFormat("en-IN").format(Math.floor(value));
}

/** Rupees from paise for a badge: ₹1,250 or ₹1,250.50. Null when unknown. */
export function formatRupees(paise: number | null | undefined): string | null {
  if (paise == null || !Number.isFinite(paise)) return null;
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/** "8:40 AM" in the app's time zone. */
export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone })
    .format(date)
    .toUpperCase();
}

/** "7 Oct" in the app's time zone. */
export function formatDayMonth(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone }).format(date);
}
