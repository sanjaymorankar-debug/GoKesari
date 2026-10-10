/**
 * Nearby shops from a real position (docs/nearby-referral-2026-10, feature 1).
 *
 * Registered, approved, live shops (status APPROVED, not deleted) with a saved
 * map location, within a radius of the user's position, nearest first. The
 * distance is the Haversine great-circle distance, worked out in PostgreSQL
 * (no PostGIS on this database) from the shops' stored latitude/longitude —
 * no Google call on this path (MAPS_USAGE.md).
 *
 * Shops without valid coordinates cannot be placed, so they are left out here
 * and listed for operations in shopsMissingLocation() (Admin → Shops without
 * location) to be fixed.
 *
 * Coordinates are stored as text: every one is checked against a number
 * pattern inside a CASE before it is cast, so one malformed value can never
 * fail the query (a WHERE clause does not promise its order of evaluation).
 */
import { sql } from "drizzle-orm";

import { directionsUrl, formatDistance, NEARBY_RADII_KM, type NearbyRadiusKm } from "@/lib/geo/nearby";
import { isShopOpenNow } from "@/lib/shop-hours";
import { shopTypeLabel, type ShopTypeKey } from "@/lib/shop-types";
import { db } from "@/server/db";
import type { Shop } from "@/server/db/schema";
import { withWalletGate } from "./serviceability";

const EARTH_RADIUS_KM = 6371;
/** The largest radius on offer: the query reads this far once and counts every smaller radius from it. */
const MAX_RADIUS_KM = NEARBY_RADII_KM[NEARBY_RADII_KM.length - 1];
const NUMBER = "^\\s*-?[0-9]{1,3}(\\.[0-9]+)?\\s*$";

/** SQL for a text column as a number, or NULL when it is not one. */
const asNumber = (column: string) => sql.raw(`CASE WHEN ${column} ~ '${NUMBER}' THEN trim(${column})::double precision END`);

export interface NearbyShopCard {
  id: string;
  slug: string;
  name: string;
  shopType: string;
  shopTypeLabel: string;
  logoUrl: string | null;
  area: string | null;
  city: string;
  pincode: string;
  latitude: number;
  longitude: number;
  /** Straight-line km, three decimals. */
  distanceKm: number;
  /** "350 m" below 1 km, otherwise "4.3 km". */
  distanceText: string;
  /** Inside its opening hours now (IST). */
  open: boolean;
  /** False while the shop is paused, below its wallet minimum or missing a legal document. */
  takingOrders: boolean;
  deliveryAvailable: boolean;
  directionsUrl: string;
}

export interface NearbyResult {
  origin: { latitude: number; longitude: number };
  radiusKm: NearbyRadiusKm;
  shops: NearbyShopCard[];
  /** How many shops each radius on offer would show — for "widen the radius". */
  countsByRadius: Record<NearbyRadiusKm, number>;
}

interface Row {
  id: string;
  slug: string;
  name: string;
  shop_type: string;
  logo_url: string | null;
  area: string | null;
  city: string;
  pincode: string;
  lat: number;
  lng: number;
  opening_hours: Shop["openingHours"];
  orders_paused: boolean;
  delivery_available: boolean;
  distance_km: number;
}

export function isValidPosition(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/** Approved live shops within `radiusKm` of the position, nearest first (at most `limit`). */
export async function findNearbyShops(
  origin: { latitude: number; longitude: number },
  radiusKm: NearbyRadiusKm,
  options: { limit?: number; now?: Date } = {},
): Promise<NearbyResult> {
  const { latitude, longitude } = origin;
  const latDelta = MAX_RADIUS_KM / 111.32;
  const lonDelta = MAX_RADIUS_KM / (111.32 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const limit = Math.min(options.limit ?? 200, 500);

  const rows = (await db.execute(sql`
    with s as (
      select id, slug, name, shop_type::text as shop_type, logo_url, area, city, pincode,
             opening_hours, orders_paused, delivery_available,
             ${asNumber("latitude")} as lat, ${asNumber("longitude")} as lng
      from shops
      where status = 'APPROVED' and deleted_at is null
    ), placed as (
      select * from s
      where lat between -90 and 90 and lng between -180 and 180 and not (lat = 0 and lng = 0)
        and lat between ${latitude - latDelta} and ${latitude + latDelta}
        and lng between ${longitude - lonDelta} and ${longitude + lonDelta}
    ), measured as (
      select *, 2 * ${EARTH_RADIUS_KM} * asin(least(1, sqrt(
        power(sin(radians(lat - ${latitude}) / 2), 2)
        + cos(radians(${latitude})) * cos(radians(lat)) * power(sin(radians(lng - ${longitude}) / 2), 2)
      ))) as distance_km
      from placed
    )
    select * from measured where distance_km <= ${MAX_RADIUS_KM}
    order by distance_km, name
    limit 2000
  `)) as unknown as Row[];

  const countsByRadius = Object.fromEntries(
    NEARBY_RADII_KM.map((r) => [r, rows.filter((row) => row.distance_km <= r).length]),
  ) as Record<NearbyRadiusKm, number>;
  const inRange = rows.filter((row) => row.distance_km <= radiusKm).slice(0, limit);
  // "Not taking orders" exactly as the rest of the site decides it (pause, wallet minimum, legal documents).
  const gated = await withWalletGate(inRange.map((r) => ({ id: r.id, ordersPaused: r.orders_paused })));
  const now = options.now ?? new Date();

  return {
    origin: { latitude, longitude },
    radiusKm,
    countsByRadius,
    shops: inRange.map((row, i) => {
      const distanceKm = Math.round(Number(row.distance_km) * 1000) / 1000;
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        shopType: row.shop_type,
        shopTypeLabel: shopTypeLabel(row.shop_type as ShopTypeKey),
        logoUrl: row.logo_url,
        area: row.area,
        city: row.city,
        pincode: row.pincode,
        latitude: Number(row.lat),
        longitude: Number(row.lng),
        distanceKm,
        distanceText: formatDistance(distanceKm),
        open: isShopOpenNow({ openingHours: row.opening_hours }, now),
        takingOrders: !gated[i].ordersPaused,
        deliveryAvailable: row.delivery_available,
        directionsUrl: directionsUrl(origin, { latitude: Number(row.lat), longitude: Number(row.lng) }),
      };
    }),
  };
}

/* --------------------------------------------------- shops without location */

export interface ShopMissingLocation {
  id: string;
  name: string;
  registrationNumber: string;
  status: string;
  ownerName: string;
  phone: string;
  addressLine1: string;
  area: string | null;
  city: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  /** Why it cannot be placed. */
  problem: "MISSING" | "INVALID";
  createdAt: Date;
}

/**
 * Shops that Nearby leaves out because they have no usable map location —
 * live (approved) shops first, then the ones waiting for approval. Rejected,
 * suspended and deleted shops are not listed.
 */
export async function shopsMissingLocation(): Promise<ShopMissingLocation[]> {
  const rows = (await db.execute(sql`
    select id, name, registration_number, status::text as status, owner_name, phone, address_line1, area, city, pincode,
           latitude, longitude, created_at,
           ${asNumber("latitude")} as lat, ${asNumber("longitude")} as lng
    from shops
    where deleted_at is null and status in ('APPROVED', 'PENDING_APPROVAL')
  `)) as unknown as {
    id: string;
    name: string;
    registration_number: string;
    status: string;
    owner_name: string;
    phone: string;
    address_line1: string;
    area: string | null;
    city: string;
    pincode: string;
    latitude: string | null;
    longitude: string | null;
    created_at: Date | string;
    lat: number | null;
    lng: number | null;
  }[];
  return rows
    .filter((r) => r.lat == null || r.lng == null || !isValidPosition(Number(r.lat), Number(r.lng)))
    .map((r) => ({
      id: r.id,
      name: r.name,
      registrationNumber: r.registration_number,
      status: r.status,
      ownerName: r.owner_name,
      phone: r.phone,
      addressLine1: r.address_line1,
      area: r.area,
      city: r.city,
      pincode: r.pincode,
      latitude: r.latitude,
      longitude: r.longitude,
      problem: (!r.latitude?.trim() && !r.longitude?.trim() ? "MISSING" : "INVALID") as "MISSING" | "INVALID",
      createdAt: new Date(r.created_at),
    }))
    .sort((a, b) => Number(b.status === "APPROVED") - Number(a.status === "APPROVED") || a.name.localeCompare(b.name));
}
