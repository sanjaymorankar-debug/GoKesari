/**
 * Places for the Nearby screen (docs/nearby-referral-2026-10, feature 1):
 *
 *  - addressForPosition: an approximate street address for the user's
 *    detected position, from OpenStreetMap (Nominatim) — free, no key. Shown
 *    on the Nearby screen and used as the "Deliver to" text (owner, 24 Oct
 *    2026: a textual address for the coordinates, not a paid service).
 *  - describePosition: the area / city / PIN for the detected position —
 *    taken from the nearest shop or saved address with a map location within
 *    2 km (GoKesari's own data, no cost); only when there is none, the
 *    OpenStreetMap answer above.
 *  - findPlace: the point to search from when location is refused or not
 *    available and the user types a PIN code or an area — the centre of the
 *    shops and saved addresses in that PIN code / area; only when there are
 *    none, Google geocoding, if the server key is set.
 *
 * Every Google call is logged to maps_api_call_log like the rest of the app
 * (MAPS_USAGE.md), and answers are kept in memory for a day, so the same
 * place is never looked up twice by one server. OpenStreetMap calls cost
 * nothing and are not logged there; they follow Nominatim's usage policy (at
 * most one a second, the app named in the User-Agent, answers cached, the
 * "© OpenStreetMap contributors" credit shown with the address).
 */
import { sql } from "drizzle-orm";

import { getEnv, isGeocodingConfigured } from "@/lib/env";
import { cleanAddress, formatOsmAddress, isPincode, type OsmAddress } from "@/lib/geo/nearby";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { db } from "@/server/db";
import { mapsApiCallLog } from "@/server/db/schema";

export interface PlaceName {
  area: string | null;
  city: string | null;
  pincode: string | null;
}

export interface FoundPlace extends PlaceName {
  latitude: number;
  longitude: number;
  /** How the point was found. */
  source: "GOKESARI" | "GOOGLE";
}

const NUMBER = "^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$";
const asNumber = (column: string) => sql.raw(`CASE WHEN ${column} ~ '${NUMBER}' THEN trim(${column})::double precision END`);

/** Every shop (not deleted) and saved address (not deleted) with a usable map location. */
const KNOWN_POINTS = sql`(
  select ${asNumber("latitude")} as lat, ${asNumber("longitude")} as lng, area, city, pincode
  from shops where deleted_at is null and status in ('APPROVED', 'PENDING_APPROVAL', 'SUSPENDED')
  union all
  select ${asNumber("latitude")} as lat, ${asNumber("longitude")} as lng, area, city, pincode
  from addresses where deleted_at is null
)`;

const DAY_MS = 86_400_000;
const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY_MS) return hit.value as T;
  return undefined;
}
function remember<T>(key: string, value: T): T {
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------ position */

export interface PositionAddress extends PlaceName {
  /** The approximate street address, e.g. "12 Lane 5, Kharadi, Pune 411014". */
  address: string;
}

const lookups = new Map<string, Promise<PositionAddress | null>>();

/**
 * An approximate street address for a position, from OpenStreetMap — null
 * when OpenStreetMap knows nothing there or NOMINATIM_URL is "off". Asked at
 * the ~11 m a saved location keeps (4 decimals) and remembered for a day, so
 * saving "Deliver to" and the Nearby screen share one request for one spot.
 * Throws (and remembers nothing, so the next one tries again) when the
 * request fails or no turn is free within 2 seconds.
 */
export async function addressForPosition(latitude: number, longitude: number): Promise<PositionAddress | null> {
  const server = nominatimServer();
  if (!server) return null;
  const lat = latitude.toFixed(4);
  const lon = longitude.toFixed(4);
  const key = `addr:${lat},${lon}`;
  const hit = cached<PositionAddress | null>(key);
  if (hit !== undefined) return hit;
  const pending = lookups.get(key);
  if (pending) return pending;
  const lookup = osmReverse(server, lat, lon)
    .then((found) => remember(key, found))
    .finally(() => lookups.delete(key));
  lookups.set(key, lookup);
  return lookup;
}

/**
 * The area / city / PIN for a position, or null when nothing is known nearby.
 * `ownDataOnly` skips OpenStreetMap (the caller has already asked
 * addressForPosition).
 */
export async function describePosition(
  latitude: number,
  longitude: number,
  options: { ownDataOnly?: boolean } = {},
): Promise<PlaceName | null> {
  const key = `pos:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const hit = cached<PlaceName | null>(key);
  if (hit !== undefined) return hit;

  const delta = 0.02; // ~2 km
  const [nearest] = (await db.execute(sql`
    with p as (select * from ${KNOWN_POINTS} k where pincode ~ '^[1-9][0-9]{5}$')
    select area, city, pincode,
      power(lat - ${latitude}, 2) + power((lng - ${longitude}) * cos(radians(${latitude})), 2) as d2
    from p
    where lat between ${latitude - delta} and ${latitude + delta}
      and lng between ${longitude - delta} and ${longitude + delta}
    order by d2
    limit 1
  `)) as unknown as { area: string | null; city: string | null; pincode: string | null }[];
  if (nearest && (nearest.area || nearest.city || nearest.pincode)) {
    return remember(key, { area: nearest.area?.trim() || null, city: nearest.city?.trim() || null, pincode: nearest.pincode });
  }
  if (options.ownDataOnly) return null;
  const osm = await addressForPosition(latitude, longitude).catch(() => undefined);
  if (osm === undefined) return null; // failed or busy: not remembered
  return remember(key, osm ? { area: osm.area, city: osm.city, pincode: osm.pincode } : null);
}

/* -------------------------------------------------------- typed place */

/** The point to search from for a typed PIN code or area, or null when it cannot be found. */
export async function findPlace(query: string): Promise<FoundPlace | null> {
  const text = query.trim().replace(/\s+/g, " ").slice(0, 80);
  if (text.length < 2) return null;
  const key = `q:${text.toLowerCase()}`;
  const hit = cached<FoundPlace | null>(key);
  if (hit !== undefined) return hit;

  const pin = isPincode(text) ? text : null;
  const match = pin
    ? sql`pincode = ${pin}`
    : sql`(lower(trim(area)) = lower(${text}) or lower(trim(city)) = lower(${text}))`;
  const [centre] = (await db.execute(sql`
    with p as (select * from ${KNOWN_POINTS} k where ${match})
    select avg(lat) as lat, avg(lng) as lng, count(*)::int as n,
      mode() within group (order by area) as area,
      mode() within group (order by city) as city,
      mode() within group (order by pincode) as pincode
    from p
    where lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0)
  `)) as unknown as { lat: number | null; lng: number | null; n: number; area: string | null; city: string | null; pincode: string | null }[];
  if (centre && centre.n > 0 && centre.lat != null && centre.lng != null) {
    return remember(key, {
      latitude: Number(centre.lat),
      longitude: Number(centre.lng),
      area: pin ? centre.area : (centre.area ?? text),
      city: centre.city,
      pincode: pin ?? centre.pincode,
      source: "GOKESARI",
    });
  }
  if (!isGeocodingConfigured()) return remember(key, null);
  const google = await googleGeocode(
    pin ? { components: `postal_code:${pin}|country:IN` } : { address: text, components: "country:IN" },
    "nearby_manual_place",
  ).catch(() => null);
  return remember(key, google && google.latitude != null && google.longitude != null ? { ...google, latitude: google.latitude, longitude: google.longitude, source: "GOOGLE" } : null);
}

/* ------------------------------------------------ a shop's own address */

export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  pincode: string | null;
}

/**
 * A shop's written address as a map point (the location backfill), or null
 * when Google does not know it or places it in a different PIN code than the
 * shop gave — a wrong pin is worse than none. Needs the server key.
 */
export async function geocodeShopAddress(
  shop: { addressLine1: string; addressLine2?: string | null; area: string | null; city: string; state?: string | null; pincode: string },
  entityId?: string,
): Promise<GeocodedAddress | null> {
  if (!isGeocodingConfigured()) return null;
  const address = [shop.addressLine1, shop.addressLine2, shop.area, shop.city, shop.state, shop.pincode]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");
  if (!address) return null;
  const components = isPincode(shop.pincode) ? `country:IN|postal_code:${shop.pincode}` : "country:IN";
  const found = await googleGeocode({ address, components }, "shop_location_backfill", entityId);
  if (!found || found.latitude == null || found.longitude == null) return null;
  if (isPincode(shop.pincode) && found.pincode && found.pincode !== shop.pincode) return null;
  return { latitude: found.latitude, longitude: found.longitude, pincode: found.pincode };
}

/* -------------------------------------------------------------- Google */

interface GeocodeResult extends PlaceName {
  latitude: number | null;
  longitude: number | null;
}

type Component = { long_name: string; types: string[] };

async function googleGeocode(params: Record<string, string>, purpose: string, entityId?: string): Promise<GeocodeResult | null> {
  const startedAt = Date.now();
  let success = false;
  let errorMessage: string | null = null;
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("region", "in");
    url.searchParams.set("key", getEnv().GOOGLE_MAPS_SERVER_API_KEY!);
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const body = (await response.json()) as {
      status: string;
      error_message?: string;
      results?: { address_components: Component[]; geometry?: { location?: { lat: number; lng: number } } }[];
    };
    if (body.status === "ZERO_RESULTS") {
      success = true;
      return null;
    }
    if (!response.ok || body.status !== "OK" || !body.results?.[0]) throw new Error(body.error_message ?? `Geocoding failed: ${body.status}`);
    success = true;
    const first = body.results[0];
    const all = body.results.flatMap((r) => r.address_components);
    const pick = (...types: string[]) => all.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? null;
    return {
      latitude: first.geometry?.location?.lat ?? null,
      longitude: first.geometry?.location?.lng ?? null,
      area: pick("sublocality_level_1", "sublocality", "neighborhood"),
      city: pick("locality", "administrative_area_level_3", "administrative_area_level_2"),
      pincode: pick("postal_code"),
    };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Unknown geocoding error";
    throw error;
  } finally {
    await db
      .insert(mapsApiCallLog)
      .values({ service: "GEOCODING", purpose, entityType: entityId ? "shop" : null, entityId: entityId ?? null, success, responseTimeMs: Date.now() - startedAt, errorMessage })
      .catch((err) => console.error("[maps] failed to record API call log", err));
  }
}

/* ------------------------------------------------------- OpenStreetMap */

const PUBLIC_NOMINATIM = "https://nominatim.openstreetmap.org";
/** Nominatim's usage policy: name the app and a contact. */
const USER_AGENT = `GoKesari/1.0 (+https://gokesari.com; ${LEGAL_ENTITY.supportEmail})`;
/** At most one request a second (Nominatim's absolute maximum), with a margin. */
const OSM_GAP_MS = 1_100;
const OSM_MAX_WAIT_MS = 2_000;
let nextOsmTurnAt = 0;

function nominatimServer(): string | null {
  const configured = getEnv().NOMINATIM_URL;
  if (configured === "off") return null;
  return (configured ?? PUBLIC_NOMINATIM).replace(/\/+$/, "");
}

/** Waits for this server's next free turn; false when it is more than 2 seconds away (the caller falls back). */
async function takeOsmTurn(): Promise<boolean> {
  const now = Date.now();
  const at = Math.max(now, nextOsmTurnAt);
  if (at - now > OSM_MAX_WAIT_MS) return false;
  nextOsmTurnAt = at + OSM_GAP_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  return true;
}

async function osmReverse(server: string, lat: string, lon: string): Promise<PositionAddress | null> {
  if (!(await takeOsmTurn())) throw new Error("OpenStreetMap: no free turn");
  const url = new URL(`${server}/reverse`);
  url.search = new URLSearchParams({ format: "jsonv2", lat, lon, zoom: "18", addressdetails: "1", "accept-language": "en" }).toString();
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OpenStreetMap reverse lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as { error?: string; display_name?: string; address?: OsmAddress };
  if (body.error) return null; // "Unable to geocode": nothing mapped there
  const formatted = formatOsmAddress(body.address);
  if (formatted) return { address: formatted.line, area: formatted.area, city: formatted.city, pincode: formatted.pincode };
  const line = cleanAddress(body.display_name);
  return line ? { address: line, area: null, city: null, pincode: null } : null;
}

/** For tests. */
export function clearPlaceCache(): void {
  cache.clear();
  lookups.clear();
  nextOsmTurnAt = 0;
}
