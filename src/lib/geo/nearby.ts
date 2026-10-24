/**
 * Nearby shops (docs/nearby-referral-2026-10, feature 1) — the pure parts
 * shared by the server and the browser: radius choices, how a distance is
 * written, and the Google Maps directions link. No imports with side effects.
 */

/** The radius filter on the Nearby screen, km. */
export const NEARBY_RADII_KM = [1, 3, 5, 10] as const;
export type NearbyRadiusKm = (typeof NEARBY_RADII_KM)[number];
export const DEFAULT_NEARBY_RADIUS_KM: NearbyRadiusKm = 5;

export function parseNearbyRadius(raw: unknown): NearbyRadiusKm {
  const n = Number(raw);
  return (NEARBY_RADII_KM as readonly number[]).includes(n) ? (n as NearbyRadiusKm) : DEFAULT_NEARBY_RADIUS_KM;
}

/** The next larger radius, or null at the largest. */
export function widerRadius(km: NearbyRadiusKm): NearbyRadiusKm | null {
  const i = NEARBY_RADII_KM.indexOf(km);
  return i >= 0 && i < NEARBY_RADII_KM.length - 1 ? NEARBY_RADII_KM[i + 1] : null;
}

/**
 * Distance as the shop card shows it: metres below 1 km (to the nearest 10 m),
 * otherwise km to one decimal — "350 m", "1.0 km", "4.3 km".
 */
export function formatDistance(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "";
  if (km < 1) {
    const metres = Math.round((km * 1000) / 10) * 10;
    // 995 m and up rounds to 1000 m: say "1.0 km" rather than "1000 m".
    return metres >= 1000 ? "1.0 km" : `${Math.max(metres, 10)} m`;
  }
  return `${(Math.round(km * 10) / 10).toFixed(1)} km`;
}

const coord = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** Google Maps directions from the user's position to the shop (opens the app on phones). */
export function directionsUrl(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${coord(origin.latitude)},${coord(origin.longitude)}`,
    destination: `${coord(destination.latitude)},${coord(destination.longitude)}`,
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** A 6-digit Indian PIN code (does not start with 0). */
export function isPincode(value: string): boolean {
  return /^[1-9]\d{5}$/.test(value.trim());
}

/** The place line at the top of the screen: "Kharadi, Pune 411014". */
export function placeLine(place: { area?: string | null; city?: string | null; pincode?: string | null } | null): string | null {
  if (!place) return null;
  const name = [place.area, place.city].map((p) => p?.trim()).filter(Boolean);
  // Area and city are often the same word for small towns.
  const unique = name.filter((p, i) => name.findIndex((q) => q!.toLowerCase() === p!.toLowerCase()) === i);
  const line = [unique.join(", "), place.pincode?.trim()].filter(Boolean).join(" ");
  return line || null;
}

/** A plus code ("XW2Q+H8") at the start of a Google address. */
const PLUS_CODE_PREFIX = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\s*,?\s*/i;

/**
 * A Google formatted address as the location line shows it: no plus code in
 * front and no ", India" at the end — "Eon Free Zone, Kharadi, Pune,
 * Maharashtra 411014". At most `max` characters, cut at a comma.
 */
export function cleanAddress(formatted: string | null | undefined, max = 120): string | null {
  if (!formatted) return null;
  let text = formatted.trim().replace(PLUS_CODE_PREFIX, "").replace(/,\s*India$/i, "").trim();
  while (text.length > max && text.includes(",")) text = text.slice(0, text.lastIndexOf(",")).trim();
  if (text.length > max) text = text.slice(0, max).trim();
  return text || null;
}
