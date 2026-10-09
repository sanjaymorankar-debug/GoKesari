/**
 * Serviceability — "does this shop deliver to this customer location?"
 * (GS-004, GS-010, feeds GS-019/020/021/022 discovery and, in Slice 2,
 * GS-026's checkout hard-block).
 *
 * Phase 1 rule, deliberately simple and explainable to a shop owner:
 *  - the shop must be APPROVED, not deleted, offer home delivery, and not have
 *    paused new orders;
 *  - a PIN code the shop lists as an extra delivery zone always qualifies;
 *  - when both the shop and the customer have coordinates, the straight-line
 *    (Haversine) distance must be within the shop's `serviceRadiusKm`;
 *  - when either side has no coordinates, fall back to an exact PIN-code
 *    match — a customer who only typed a PIN, or a shop that never pinned
 *    its location, can still be matched, but never by guessing distance.
 *
 * No Google Distance Matrix call anywhere here (see MAPS_USAGE.md) — the same
 * straight-line approach delivery-eligibility.ts already uses.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { shops, shopWallets, societies, societyShops, type Shop } from "@/server/db/schema";
import { getRule } from "./settings";

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
  | "status"
  | "deletedAt"
  | "deliveryAvailable"
  | "latitude"
  | "longitude"
  | "pincode"
  | "serviceRadiusKm"
  | "deliveryPincodes"
  | "ordersPaused"
>;

/**
 * Rule shopWallet: a shop whose prepaid wallet is below the minimum cannot
 * accept orders, so customers cannot order from it either — it is treated
 * exactly like a shop that paused its orders ("not taking new orders right
 * now"; the customer is never told why). These helpers apply that to every
 * check that reads `ordersPaused`. Nothing changes while the rule is off.
 */
export async function walletOrderGate(): Promise<SQL> {
  const rules = await getRule("shopWallet");
  if (!rules.enabled) return sql`true`;
  // Raw names: the correlated subquery must point at the outer shops row.
  return sql`coalesce((select sw.balance_paise from shop_wallets sw where sw.shop_id = shops.id), 0) >= ${rules.minBalancePaise}`;
}

/** The shops among `shopIds` customers cannot order from because their wallet is below the minimum. */
export async function shopsBelowWalletMinimum(shopIds: string[]): Promise<Set<string>> {
  if (shopIds.length === 0) return new Set();
  const rules = await getRule("shopWallet");
  if (!rules.enabled) return new Set();
  const rows = await db
    .select({ id: shops.id })
    .from(shops)
    .leftJoin(shopWallets, eq(shopWallets.shopId, shops.id))
    .where(and(inArray(shops.id, shopIds), sql`coalesce(${shopWallets.balancePaise}, 0) < ${rules.minBalancePaise}`));
  return new Set(rows.map((r) => r.id));
}

/** Shop rows with `ordersPaused` set where the wallet gate closes the shop, for the checks that read it. */
export async function withWalletGate<T extends Pick<Shop, "id" | "ordersPaused">>(rows: T[]): Promise<T[]> {
  const blocked = await shopsBelowWalletMinimum(rows.filter((r) => !r.ordersPaused).map((r) => r.id));
  // Mandatory legal documents (docs/four-features-2026-10, the owner's decision of 9 Oct 2026): a shop past
  // its grace period is closed the same way. Imported lazily: legal-documents.ts sits above this module.
  const { legallyBlockedShopIds } = await import("./legal-documents");
  for (const id of await legallyBlockedShopIds(rows.filter((r) => !r.ordersPaused && !blocked.has(r.id)).map((r) => r.id))) blocked.add(id);
  return blocked.size === 0 ? rows : rows.map((r) => (blocked.has(r.id) ? { ...r, ordersPaused: true } : r));
}

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
  if (shop.ordersPaused) {
    return { deliversHere: false, distanceKm, reason: "This shop is not taking new orders right now." };
  }
  if (location.pincode && shop.deliveryPincodes?.includes(location.pincode)) {
    return { deliversHere: true, distanceKm, reason: null };
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

export type ServiceableShop = Shop & ShopServiceability & { societyPartner?: boolean };

/**
 * Shops a VERIFIED society lists for its residents. They count as delivering
 * to that society's addresses even outside their own radius (society-aware
 * serviceability) — provided they are approved and offer delivery.
 */
export async function societyPartnerShopIds(societyId: string | null | undefined): Promise<Set<string>> {
  if (!societyId) return new Set();
  const rows = await db
    .select({ shopId: societyShops.shopId })
    .from(societyShops)
    .innerJoin(societies, eq(societyShops.societyId, societies.id))
    .innerJoin(shops, eq(societyShops.shopId, shops.id))
    .where(
      and(
        eq(societyShops.societyId, societyId),
        eq(societyShops.status, "ACTIVE"),
        eq(societies.status, "VERIFIED"),
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        eq(shops.deliveryAvailable, true),
        eq(shops.ordersPaused, false),
        await walletOrderGate(),
      ),
    );
  return new Set(rows.map((r) => r.shopId));
}

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
  if (location.pincode) {
    near.push(sql`${shops.pincode} = ${location.pincode}`);
    near.push(sql`${shops.deliveryPincodes} @> ${JSON.stringify([location.pincode])}::jsonb`);
  }
  const partners = await societyPartnerShopIds(location.societyId);
  if (partners.size > 0) near.push(inArray(shops.id, [...partners]));
  if (near.length === 0) return [];

  const candidates = await db
    .select()
    .from(shops)
    .where(
      and(
        eq(shops.status, "APPROVED"),
        isNull(shops.deletedAt),
        eq(shops.deliveryAvailable, true),
        eq(shops.ordersPaused, false),
        await walletOrderGate(),
        or(...near),
      ),
    )
    .limit(1000);

  return candidates
    .map((shop) => {
      const check = shopServiceability(shop, location);
      return partners.has(shop.id)
        ? { ...shop, ...check, deliversHere: true, reason: null, societyPartner: true }
        : { ...shop, ...check, societyPartner: false };
    })
    .filter((shop) => shop.deliversHere)
    // Society partner shops first, then nearest.
    .sort(
      (a, b) =>
        Number(b.societyPartner) - Number(a.societyPartner) ||
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, Math.min(options.limit ?? 200, 500));
}

/** Ids of the shops serving `location` — the filter discovery queries apply. */
export async function serviceableShopIds(location: CustomerLocation): Promise<Map<string, number | null>> {
  const served = await listServiceableShops(location, { limit: 500 });
  return new Map(served.map((shop) => [shop.id, shop.distanceKm]));
}

/* ------------------------------------------------------------ nearby shops */

/**
 * How close a shop must be to count as "near" when it does not deliver to the
 * customer (a pickup-only shop, or one whose delivery radius stops short).
 * Roughly a short ride. A shop that does deliver is near whatever its distance.
 */
/** Code default; the live value is rule `discovery.nearbyRadiusKm`. */
export const NEARBY_RADIUS_KM = 5;

/** A shop card's fields, plus how the shop relates to the customer's location. */
export type NearbyShop = Pick<
  Shop,
  | "id"
  | "slug"
  | "name"
  | "logoUrl"
  | "ownerName"
  | "area"
  | "city"
  | "pincode"
  | "shopType"
  | "deliveryAvailable"
  | "openingHours"
  | "ratingAvgX100"
  | "ratingCount"
  | "preparationTimeMinutes"
  | "createdAt"
> & {
  /** Home delivery of ordinary orders reaches this location. */
  deliversHere: boolean;
  distanceKm: number | null;
  /** The shop has products customers can subscribe to (delivered daily). */
  subscriptionDelivery: boolean;
};

/**
 * Approved shops near `location`, whether or not they deliver there: every
 * shop that delivers to it, plus pickup-only and out-of-radius shops within
 * NEARBY_RADIUS_KM (or, without coordinates on either side, in the same PIN
 * code). Each says whether it delivers here, so a screen can list "shops
 * near you" and offer "delivers to me" as a filter instead of hiding the
 * pickup-only shops altogether.
 *
 * Delivering shops first (society partners, then nearest), then the rest
 * nearest first.
 */
export async function listNearbyShops(
  location: CustomerLocation,
  options: { limit?: number } = {},
): Promise<NearbyShop[]> {
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
  if (location.pincode) {
    near.push(sql`${shops.pincode} = ${location.pincode}`);
    near.push(sql`${shops.deliveryPincodes} @> ${JSON.stringify([location.pincode])}::jsonb`);
  }
  const partners = await societyPartnerShopIds(location.societyId);
  if (partners.size > 0) near.push(inArray(shops.id, [...partners]));
  if (near.length === 0) return [];

  const candidates = await db
    .select({
      shop: shops,
      // Raw names throughout: in a select list Drizzle writes a bare "id",
      // which is ambiguous inside this subquery.
      subscriptionDelivery: sql<boolean>`exists (
        select 1 from shop_products sp join products p on p.id = sp.product_id
        where sp.shop_id = shops.id and sp.deleted_at is null
          and p.subscribable and sp.is_active and sp.is_available and sp.online_sale_enabled)`,
    })
    .from(shops)
    .where(and(eq(shops.status, "APPROVED"), isNull(shops.deletedAt), or(...near)))
    .limit(1000);
  // Shown, but like a paused shop (not delivering) while its wallet is below the minimum.
  const gated = await withWalletGate(candidates.map((c) => c.shop));

  const { nearbyRadiusKm } = await getRule("discovery");
  return candidates
    .map(({ subscriptionDelivery }, i) => {
      const shop = gated[i];
      const check = shopServiceability(shop, location);
      const partner = partners.has(shop.id);
      const samePin = Boolean(location.pincode) && location.pincode === shop.pincode;
      return {
        shop,
        subscriptionDelivery,
        partner,
        deliversHere: partner || check.deliversHere,
        distanceKm: check.distanceKm,
        near:
          partner ||
          check.deliversHere ||
          (check.distanceKm != null ? check.distanceKm <= nearbyRadiusKm : samePin),
      };
    })
    .filter((row) => row.near)
    .sort(
      (a, b) =>
        Number(b.deliversHere) - Number(a.deliversHere) ||
        Number(b.partner) - Number(a.partner) ||
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY) ||
        a.shop.name.localeCompare(b.shop.name),
    )
    .slice(0, Math.min(options.limit ?? 200, 500))
    // Card fields only: the full row (owner phone, fee, tax details) stops here.
    .map(({ shop, subscriptionDelivery, deliversHere, distanceKm }) => ({
      id: shop.id,
      slug: shop.slug,
      name: shop.name,
      logoUrl: shop.logoUrl,
      ownerName: shop.ownerName,
      area: shop.area,
      city: shop.city,
      pincode: shop.pincode,
      shopType: shop.shopType,
      deliveryAvailable: shop.deliveryAvailable,
      openingHours: shop.openingHours,
      ratingAvgX100: shop.ratingAvgX100,
      ratingCount: shop.ratingCount,
      preparationTimeMinutes: shop.preparationTimeMinutes,
      createdAt: shop.createdAt,
      deliversHere,
      distanceKm,
      subscriptionDelivery,
    }));
}
