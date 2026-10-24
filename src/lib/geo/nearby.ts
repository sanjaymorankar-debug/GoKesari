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

/**
 * An address as the location line shows it: no ", India" at the end, at most
 * `max` characters, cut at a comma.
 */
export function cleanAddress(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  let line = text.trim().replace(/,\s*India$/i, "").trim();
  while (line.length > max && line.includes(",")) line = line.slice(0, line.lastIndexOf(",")).trim();
  if (line.length > max) line = line.slice(0, max).trim();
  return line || null;
}

/** The parts of an OpenStreetMap (Nominatim) reverse-geocoding answer the location line uses. */
export interface OsmAddress {
  house_number?: string;
  road?: string;
  building?: string;
  amenity?: string;
  shop?: string;
  office?: string;
  neighbourhood?: string;
  suburb?: string;
  quarter?: string;
  city_district?: string;
  hamlet?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  state_district?: string;
  county?: string;
  postcode?: string;
}

const firstOf = (...values: (string | undefined)[]) => values.map((v) => v?.trim()).find(Boolean) ?? null;

/**
 * An OpenStreetMap address as the location line shows it — approximate,
 * street level: "12 Lane 5, Kharadi, Pune 411014" (place name, street, area,
 * city, PIN code — whichever OpenStreetMap has). Null when it has none.
 */
export function formatOsmAddress(
  address: OsmAddress | null | undefined,
): { line: string; area: string | null; city: string | null; pincode: string | null } | null {
  if (!address) return null;
  const a = address;
  const place = firstOf(a.building, a.amenity, a.shop, a.office);
  const street = firstOf([a.house_number?.trim(), a.road?.trim()].filter(Boolean).join(" "));
  const area = firstOf(a.suburb, a.neighbourhood, a.quarter, a.city_district, a.hamlet);
  const city = firstOf(a.city, a.town, a.village, a.municipality, a.state_district, a.county);
  const pin = a.postcode?.replace(/\s/g, "") ?? "";
  const pincode = isPincode(pin) ? pin : null;
  const parts = [place, street, area, city].filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  if (unique.length === 0) return null;
  const line = cleanAddress(`${unique.join(", ")}${pincode ? ` ${pincode}` : ""}`);
  return line ? { line, area, city, pincode } : null;
}
