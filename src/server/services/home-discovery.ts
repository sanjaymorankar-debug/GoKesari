/**
 * Home page discovery (docs/homepage-uiux-2026-10): "Popular items in your
 * area" for customers with nothing to buy again (F3), and how many nearby
 * shops sell each product, for the "Compare N prices" link (F4).
 *
 * Read-only. Popular items step outwards until something is found: shops
 * that serve the visitor's location → the city those shops are in → the
 * whole platform → (a quiet site with no orders yet) products on sale near
 * the visitor. Only listings that can be bought online right now are shown.
 */
import { and, count, countDistinct, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { orderItems, orders, products, shopProducts, shops } from "@/server/db/schema";
import { shopCarriesProductCategory } from "./product-categories";
import { serviceableShopIds } from "./serviceability";

export interface PopularItem {
  shopProductId: string;
  productId: string;
  name: string;
  unit: string;
  unitSizeMilli: number;
  shopName: string;
  shopSlug: string;
  imageUrl: string | null;
  pricePaise: number;
  /** Orders of it in the window; 0 for the "on sale near you" fallback. */
  orders: number;
}

export type PopularScope = "area" | "city" | "platform" | "catalogue";

/** Orders that count as a purchase: paid and not cancelled, failed or returned. */
const PURCHASED = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"] as const;
const WINDOW_DAYS = 60;

/** A listing a customer could add to the cart now (the server re-checks at add-to-cart regardless). */
function purchasable(): SQL {
  return and(
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    eq(shopProducts.isActive, true),
    isNull(shopProducts.deletedAt),
    eq(shopProducts.isAvailable, true),
    eq(shopProducts.onlineSaleEnabled, true),
    isNotNull(shopProducts.onlinePricePaise),
    gt(shopProducts.onlinePricePaise, 0),
    or(eq(shopProducts.trackInventory, false), gt(shopProducts.onlineStock, 0)),
    eq(products.isActive, true),
    shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
  )!;
}

const itemColumns = {
  shopProductId: shopProducts.id,
  productId: products.id,
  name: products.name,
  unit: products.unit,
  unitSizeMilli: products.unitSizeMilli,
  shopName: shops.name,
  shopSlug: shops.slug,
  listingImage: shopProducts.imageUrl,
  productImage: products.imageUrl,
  pricePaise: shopProducts.onlinePricePaise,
};

/** The purchasable listings among these ids, keyed by id. */
async function liveListings(ids: string[]) {
  if (ids.length === 0) return new Map<string, Omit<PopularItem, "orders">>();
  const rows = await db
    .select(itemColumns)
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(and(inArray(shopProducts.id, ids), purchasable()));
  return new Map(
    rows.map((r) => [
      r.shopProductId,
      {
        shopProductId: r.shopProductId,
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        unitSizeMilli: r.unitSizeMilli,
        shopName: r.shopName,
        shopSlug: r.shopSlug,
        imageUrl: r.listingImage ?? r.productImage ?? null,
        pricePaise: r.pricePaise ?? 0,
      },
    ]),
  );
}

/** Most-ordered listings in the window, optionally only at these shops or in this city. */
async function mostOrdered(filter: { shopIds?: string[]; city?: string }, limit: number): Promise<PopularItem[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const where: SQL[] = [inArray(orders.status, [...PURCHASED]), gte(orders.createdAt, since)];
  if (filter.shopIds) where.push(inArray(orders.shopId, filter.shopIds));
  if (filter.city) where.push(sql`${orders.shopId} IN (SELECT id FROM shops WHERE lower(city) = ${filter.city.toLowerCase()})`);
  const ranked = await db
    .select({ shopProductId: orderItems.shopProductId, n: countDistinct(orders.id) })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(...where))
    .groupBy(orderItems.shopProductId)
    .orderBy(desc(countDistinct(orders.id)))
    .limit(limit * 3);
  const live = await liveListings(ranked.map((r) => r.shopProductId));
  const out: PopularItem[] = [];
  const seenProducts = new Set<string>();
  for (const r of ranked) {
    const item = live.get(r.shopProductId);
    // One card per product: the most-ordered shop's listing of it.
    if (!item || seenProducts.has(item.productId)) continue;
    seenProducts.add(item.productId);
    out.push({ ...item, orders: Number(r.n) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Products on sale (online) at these shops — or anywhere — when nothing has been ordered yet. */
async function onSale(shopIds: string[] | null, limit: number): Promise<PopularItem[]> {
  const rows = await db
    .select(itemColumns)
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(and(purchasable(), shopIds ? inArray(shopProducts.shopId, shopIds) : undefined))
    .orderBy(desc(shops.ratingCount), products.name)
    .limit(limit * 3);
  const out: PopularItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.productId)) continue;
    seen.add(r.productId);
    out.push({
      shopProductId: r.shopProductId,
      productId: r.productId,
      name: r.name,
      unit: r.unit,
      unitSizeMilli: r.unitSizeMilli,
      shopName: r.shopName,
      shopSlug: r.shopSlug,
      imageUrl: r.listingImage ?? r.productImage ?? null,
      pricePaise: r.pricePaise ?? 0,
      orders: 0,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * "Popular items in your area": location (shops that serve it) → their city
 * → platform → on sale nearby. Never throws; [] when the database is not
 * reachable.
 */
export async function popularInArea(
  location: CustomerLocation | null,
  options: { limit?: number; nearbyShopIds?: string[]; cities?: string[] } = {},
): Promise<{ scope: PopularScope; items: PopularItem[] }> {
  const limit = options.limit ?? 8;
  try {
    const nearby = options.nearbyShopIds ?? (location ? [...(await serviceableShopIds(location)).keys()] : []);
    if (nearby.length > 0) {
      const area = await mostOrdered({ shopIds: nearby }, limit);
      if (area.length > 0) return { scope: "area", items: area };
    }
    for (const city of options.cities ?? []) {
      const inCity = await mostOrdered({ city }, limit);
      if (inCity.length > 0) return { scope: "city", items: inCity };
    }
    const platform = await mostOrdered({}, limit);
    if (platform.length > 0) return { scope: "platform", items: platform };
    return { scope: "catalogue", items: await onSale(nearby.length > 0 ? nearby : null, limit) };
  } catch (error) {
    console.error("[home] popular items could not be read", error);
    return { scope: "catalogue", items: [] };
  }
}

/**
 * productId → how many of these shops sell it online right now. A product
 * card offers "Compare N prices" when N ≥ 2 (F4).
 */
export async function nearbyOfferCounts(productIds: readonly string[], shopIds: readonly string[]): Promise<Map<string, number>> {
  if (productIds.length === 0 || shopIds.length < 2) return new Map();
  try {
    const rows = await db
      .select({ productId: shopProducts.productId, n: count() })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .innerJoin(shops, eq(shops.id, shopProducts.shopId))
      .where(and(inArray(shopProducts.productId, [...new Set(productIds)]), inArray(shopProducts.shopId, [...shopIds]), purchasable()))
      .groupBy(shopProducts.productId);
    return new Map(rows.map((r) => [r.productId, Number(r.n)]));
  } catch (error) {
    console.error("[home] compare counts could not be read", error);
    return new Map();
  }
}
