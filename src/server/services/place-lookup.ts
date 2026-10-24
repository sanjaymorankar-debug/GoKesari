/**
 * Places for the Nearby screen (docs/nearby-referral-2026-10, feature 1):
 *
 *  - describePosition: the area / city / PIN shown at the top for the user's
 *    detected position — taken from the nearest shop or saved address with a
 *    map location within 2 km (GoKesari's own data, no cost); only when there
 *    is none, Google reverse geocoding, if the server key is set.
 *  - findPlace: the point to search from when location is refused or not
 *    available and the user types a PIN code or an area — the centre of the
 *    shops and saved addresses in that PIN code / area; only when there are
 *    none, Google geocoding, if the server key is set.
 *
 * Every Google call is logged to maps_api_call_log like the rest of the app
 * (MAPS_USAGE.md), and answers are kept in memory for a day, so the same
 * place is never looked up twice by one server.
 */
import { sql } from "drizzle-orm";

import { getEnv, isGeocodingConfigured } from "@/lib/env";
import { isPincode } from "@/lib/geo/nearby";
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

/**
 * The area / city / PIN for a position, or null when nothing is known nearby.
 * `google: false` answers from GoKesari's own data only — for saving a
 * delivery location (POST /api/location), which must not cost a Maps call per
 * visitor (MAPS_USAGE.md).
 */
export async function describePosition(
  latitude: number,
  longitude: number,
  options: { google?: boolean } = {},
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
  // Not remembered: the Nearby screen asking later may still ask Google.
  if (options.google === false) return null;
  if (!isGeocodingConfigured()) return remember(key, null);
  const google = await googleGeocode({ latlng: `${latitude},${longitude}` }, "nearby_position_label").catch(() => null);
  return remember(key, google ? { area: google.area, city: google.city, pincode: google.pincode } : null);
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

/** For tests. */
export function clearPlaceCache(): void {
  cache.clear();
}
