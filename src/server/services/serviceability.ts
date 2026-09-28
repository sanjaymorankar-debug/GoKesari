/**
 * Serviceability — "does this shop deliver to this customer location?"
 * (GS-004, GS-010, feeds GS-019/020/021/022 discovery and, in Slice 2,
 * GS-026's checkout hard-block).
 *
 * Phase 1 rule, deliberately simple and explainable to a shop owner:
 *  - the shop must be APPROVED, not deleted, and offer home delivery;
 *  - when both the shop and the customer have coordinates, the straight-line
 *    (Haversine) distance must be within the shop's `serviceRadiusKm`;
 *  - when either side has no coordinates, fall back to an exact PIN-code
 *    match — a customer who only typed a PIN, or a shop that never pinned
 *    its location, can still be matched, but never by guessing distance.
 *
 * No Google Distance Matrix call anywhere here (see MAPS_USAGE.md) — the same
 * straight-line approach delivery-eligibility.ts already uses.
 */
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { shops, type Shop } from "@/server/db/schema";

/** Upper bound of any shop's radius (the schema CHECK) — used for the SQL pre-filter. */
const MAX_SERVICE_RADIUS_KM = 50;

export interface ShopServiceability {
  /** True when the shop delivers to the location. */
  deliversHere: boolean;
  /** Straight-line km, or null when either side has no coordinates. */
  distanceKm: number | null;
  /** Customer-readable reason when `deliversHere` is false. */
  reason: string | null;
}

type ServiceabilityShop = Pick<
  Shop,
  "status" | "deletedAt" | "deliveryAvailable" | "latitude" | "longitude" | "pincode" | "serviceRadiusKm"
>;

export function shopServiceability(
  shop: ServiceabilityShop,
  location: CustomerLocation,
): ShopServiceability {
  const shopCoords = parseCoordinates(shop.latitude, shop.longitude);
  const customerCoords =
    location.latitude != null && location.longitude != null
      ? { latitude: location.latitude, longitude: location.longitude }
      : null;
  const distanceKm =
    shopCoords && customerCoords
      ? Math.round(haversineDistanceKm(shopCoords, customerCoords) * 10) / 10
      : null;

  if (shop.status !== "APPROVED" || shop.deletedAt) {
    return { deliversHere: false, distanceKm, reason: "This shop is not open for orders." };
  }
  if (!shop.deliveryAvailable) {
    return { deliversHere: false, distanceKm, reason: "This shop offers pickup only." };
  }
  if (distanceKm != null) {
    return distanceKm <= shop.serviceRadiusKm
      ? { deliversHere: true, distanceKm, reason: null }
      : {
          deliversHere: false,
          distanceKm,
          reason: `This shop delivers up to ${shop.serviceRadiusKm} km — you are ${distanceKm} km away.`,
        };
  }
  if (location.pincode && location.pincode === shop.pincode) {
    return { deliversHere: true, distanceKm: null, reason: null };
  }
  return {
    deliversHere: false,
    distanceKm: null,
    reason: "This shop does not deliver to your PIN code.",
  };
}

export type ServiceableShop = Shop & ShopServiceability;

/**
 * Approved delivering shops that serve `location`, nearest first (shops
 * matched by PIN only, with no distance, come after the distance-ranked ones).
 *
 * SQL narrows candidates to a bounding box around the customer (or to the
 * PIN code) so this never loads every shop; the exact radius test runs in
 * shopServiceability() so there is one definition of "serviceable".
 */
export async function listServiceableShops(
  location: CustomerLocation,
  options: { limit?: number } = {},
): Promise<ServiceableShop[]> {
  const near: SQL[] = [];
  if (location.latitude != null && location.longitude != null) {
    const latDelta = MAX_SERVICE_RADIUS_KM / 111;
    const lonDelta =
      MAX_SERVICE_RADIUS_KM / (111 * Math.max(Math.cos((location.latitude * Math.PI) / 180), 0.01));
    near.push(
      sql`(${shops.latitude} ~ '^-?[0-9.]+$' AND ${shops.longitude} ~ '^-?[0-9.]+$'
        AND ${shops.latitude}::double precision BETWEEN ${location.latitude - latDelta} AND ${location.latitude + latDelta}
        AND ${shops.longitude}::double precision BETWEEN ${location.longitude - lonDelta} AND ${location.longitude + lonDelta})`,
    );
  }
  if (location.pincode) near.push(sql`${shops.pincode} = ${location.pincode}`);
  if (near.length === 0) return [];

  const candidates = await db
    .select()
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        eq(shops.deliveryAvailable, true),
        or(...near),
      ),
    )
    .limit(1000);

  return candidates
    .map((shop) => ({ ...shop, ...shopServiceability(shop, location) }))
    .filter((shop) => shop.deliversHere)
    .sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY))
    .slice(0, Math.min(options.limit ?? 200, 500));
}

/** Ids of the shops serving `location` — the filter discovery queries apply. */
export async function serviceableShopIds(location: CustomerLocation): Promise<Map<string, number | null>> {
  const served = await listServiceableShops(location, { limit: 500 });
  return new Map(served.map((shop) => [shop.id, shop.distanceKm]));
}
