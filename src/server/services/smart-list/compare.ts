/**
 * Wishlist → price comparison across nearby shops (docs/smart-shopping-2026-11, Feature 1 §4).
 *
 * Shops: the existing Nearby logic (listNearbyShops) limited to the radius in
 * rule smartShopping.comparisonRadiusKm (default 3 km), open for orders,
 * nearest first, at most maxShopsCompared. For each shop a virtual cart is
 * built from the wishlist:
 *   - each item takes the shop's listing of the matched master product, or
 *     else the cheapest listing of a similar product (same item name, a
 *     comparable unit) — labelled "similar";
 *   - pack sizes are converted (2 kg from 1 kg packs = 2 packs; 1.25 kg from
 *     500 g packs = 3 packs, difference shown); loose goods take the exact amount;
 *   - an item counts as available only when the shop has enough in stock;
 *   - loose goods without a price are "Price on confirmation" and left out of
 *     the total;
 *   - prices are the shop's online price after live offers, as the cart charges.
 * Delivery options per shop: pickup, the shop's own delivery, or a GoKesari
 * delivery partner — with the shop's delivery fee and an estimated time.
 * Nothing is written here.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { CustomerLocation } from "@/lib/location";
import { type BaseUnit, packInBase, planPacks } from "@/lib/qty-words";
import { db } from "@/server/db";
import { products, shopProducts, shops, smartWishlistItems } from "@/server/db/schema";
import { computeDeliveryFee } from "@/server/services/cart";
import { shopCarriesProductCategory } from "@/server/services/product-categories";
import { listNearbyShops } from "@/server/services/serviceability";
import { getRule } from "@/server/services/settings";
import { getLiveOffers, priceWithOffers } from "@/server/services/shop-offers";

export interface WishItem {
  id: string;
  nameEn: string;
  nameLocal: string | null;
  productId: string | null;
  quantityAmount: number;
  quantityUnit: BaseUnit;
}

export type ItemStatus = "AVAILABLE" | "SIMILAR" | "LOW_STOCK" | "PRICE_ON_CONFIRMATION" | "MISSING";

export interface ShopItemQuote {
  itemId: string;
  status: ItemStatus;
  shopProductId: string | null;
  productId: string | null;
  productName: string | null;
  /** Cart quantity (packs, or kilos/litres for loose goods). */
  cartQuantity: number;
  packNote: string | null;
  /** Price of one cart unit after offers; null = price on confirmation. */
  unitPricePaise: number | null;
  linePaise: number | null;
  /** In stock now (sellable units), when tracked. */
  stockLeft: number | null;
}

export interface DeliveryOption {
  key: "PICKUP" | "SHOP_DELIVERY" | "GOKESARI_PARTNER";
  feePaise: number;
  etaMinutes: number;
}

export interface ShopQuote {
  shopId: string;
  shopName: string;
  shopSlug: string;
  area: string | null;
  distanceKm: number | null;
  rating: number | null;
  ratingCount: number;
  available: number;
  total: number;
  missing: string[];
  itemsPaise: number;
  /** Items left out of the total because the shop prices them on confirmation. */
  priceOnConfirmation: number;
  deliveryOptions: DeliveryOption[];
  /** Items + the cheapest delivery option (pickup is free). */
  cheapestTotalPaise: number;
  items: ShopItemQuote[];
}

export interface Comparison {
  radiusKm: number;
  shops: ShopQuote[];
  itemIds: string[];
  comparedAt: string;
}

type Listing = {
  shopProductId: string;
  shopId: string;
  productId: string;
  productName: string;
  kind: string;
  unit: string;
  unitSizeMilli: number;
  categoryId: string;
  onlinePricePaise: number | null;
  trackInventory: boolean;
  onlineStock: number;
  isAvailable: boolean;
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Listings at these shops of the item's product, or of products whose name is like the item's. */
async function listingsFor(item: WishItem, shopIds: string[]): Promise<Listing[]> {
  const en = item.nameEn.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").trim().slice(0, 60);
  const local = (item.nameLocal ?? "").toLowerCase().trim().slice(0, 60);
  const similar = [
    en ? sql`(${products.name} % ${en} OR ${products.name} ILIKE ${"%" + en.replace(/[%_\\]/g, "") + "%"})` : null,
    local ? sql`EXISTS (SELECT 1 FROM product_local_names pln WHERE pln.product_id = ${products.id} AND ${local} <% pln.search_text)` : null,
  ].filter(Boolean);
  const byProduct = item.productId ? eq(shopProducts.productId, item.productId) : null;
  const which = [byProduct, ...similar].filter(Boolean) as ReturnType<typeof sql>[];
  if (which.length === 0) return [];
  return db
    .select({
      shopProductId: shopProducts.id,
      shopId: shopProducts.shopId,
      productId: products.id,
      productName: products.name,
      kind: products.kind,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
      categoryId: products.categoryId,
      onlinePricePaise: shopProducts.onlinePricePaise,
      trackInventory: shopProducts.trackInventory,
      onlineStock: shopProducts.onlineStock,
      isAvailable: shopProducts.isAvailable,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(
      and(
        inArray(shopProducts.shopId, shopIds),
        eq(shopProducts.isActive, true),
        isNull(shopProducts.deletedAt),
        // Sold online, or a loose good the shop has not priced yet ("Price on confirmation").
        or(eq(shopProducts.onlineSaleEnabled, true), and(isNull(shopProducts.onlinePricePaise), eq(products.kind, "LOOSE"))),
        eq(products.isActive, true),
        shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
        or(...which),
      ),
    )
    .limit(400) as unknown as Promise<Listing[]>;
}

/** The cart quantity of a listing that meets the request, or null when the units can't be compared. */
export function cartQuantityFor(item: WishItem, l: Pick<Listing, "kind" | "unit" | "unitSizeMilli">): { qty: number; note: string | null } | null {
  const pack = packInBase(l.unit, l.unitSizeMilli);
  if (!pack) return null;
  const request = { amount: item.quantityAmount, unit: item.quantityUnit, display: `${item.quantityAmount} ${item.quantityUnit}` };
  if (l.kind === "LOOSE" && pack.unit === item.quantityUnit) {
    // Loose goods are sold by the kilo / litre: take exactly what was asked (3 decimals).
    const qty = Math.max(0.001, round3(item.quantityAmount / pack.amount));
    return { qty, note: null };
  }
  const plan = planPacks(request, pack);
  return plan ? { qty: plan.packs, note: plan.difference === 0 ? (plan.packs > 1 ? plan.note : null) : plan.note } : null;
}

function quote(item: WishItem, candidates: Listing[], offers: Awaited<ReturnType<typeof getLiveOffers>>): ShopItemQuote {
  const missing: ShopItemQuote = {
    itemId: item.id, status: "MISSING", shopProductId: null, productId: null, productName: null,
    cartQuantity: 0, packNote: null, unitPricePaise: null, linePaise: null, stockLeft: null,
  };
  let best: ShopItemQuote | null = null;
  for (const l of candidates) {
    const q = cartQuantityFor(item, l);
    if (!q) continue;
    const exact = l.productId === item.productId;
    const priced = l.onlinePricePaise != null ? priceWithOffers(l.onlinePricePaise, { shopId: l.shopId, shopProductId: l.shopProductId, categoryId: l.categoryId }, offers).unitPricePaise : null;
    const enough = l.isAvailable && (!l.trackInventory || l.onlineStock >= q.qty);
    const status: ItemStatus = !enough ? "LOW_STOCK" : priced == null ? "PRICE_ON_CONFIRMATION" : exact ? "AVAILABLE" : "SIMILAR";
    const line = priced != null ? Math.round(priced * q.qty) : null;
    const candidate: ShopItemQuote = {
      itemId: item.id, status, shopProductId: l.shopProductId, productId: l.productId, productName: l.productName,
      cartQuantity: q.qty, packNote: q.note, unitPricePaise: priced, linePaise: line, stockLeft: l.trackInventory ? l.onlineStock : null,
    };
    // Prefer: in stock and priced > in stock unpriced > low stock; then the exact product; then cheapest.
    const rank = (s: ShopItemQuote) => (s.status === "AVAILABLE" || s.status === "SIMILAR" ? 0 : s.status === "PRICE_ON_CONFIRMATION" ? 1 : 2);
    if (
      !best ||
      rank(candidate) < rank(best) ||
      (rank(candidate) === rank(best) && (candidate.status === "AVAILABLE") && best.status !== "AVAILABLE") ||
      (rank(candidate) === rank(best) && candidate.status === best.status && (candidate.linePaise ?? Infinity) < (best.linePaise ?? Infinity))
    ) {
      best = candidate;
    }
  }
  return best ?? missing;
}

/** Rough delivery time: preparation + 4 min/km (+10 to hand over to a partner). An estimate, labelled as such. */
function eta(prepMinutes: number | null, distanceKm: number | null, partner: boolean): number {
  return Math.round((prepMinutes ?? 20) + (distanceKm ?? 2) * 4 + (partner ? 10 : 0));
}

export async function compareWishlist(items: WishItem[], location: CustomerLocation): Promise<Comparison> {
  const rule = await getRule("smartShopping");
  const nearby = (await listNearbyShops(location, { limit: 200 }))
    .filter((s) => !s.ordersPaused)
    .filter((s) => (s.distanceKm != null ? s.distanceKm <= rule.comparisonRadiusKm : s.pincode === location.pincode))
    .sort((a, b) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99))
    .slice(0, rule.maxShopsCompared);
  const comparedAt = new Date().toISOString();
  if (nearby.length === 0 || items.length === 0) return { radiusKm: rule.comparisonRadiusKm, shops: [], itemIds: items.map((i) => i.id), comparedAt };

  const shopIds = nearby.map((s) => s.id);
  const [fullShops, offers, perItem] = await Promise.all([
    db.select().from(shops).where(inArray(shops.id, shopIds)),
    getLiveOffers(shopIds),
    Promise.all(items.map((i) => listingsFor(i, shopIds))),
  ]);
  const shopRow = new Map(fullShops.map((s) => [s.id, s]));

  const quotes: ShopQuote[] = [];
  for (const s of nearby) {
    const row = shopRow.get(s.id);
    if (!row) continue;
    const itemQuotes = items.map((item, idx) => quote(item, perItem[idx].filter((l) => l.shopId === s.id), offers));
    const priced = itemQuotes.filter((q) => (q.status === "AVAILABLE" || q.status === "SIMILAR") && q.linePaise != null);
    const itemsPaise = priced.reduce((sum, q) => sum + (q.linePaise ?? 0), 0);
    const available = itemQuotes.filter((q) => q.status === "AVAILABLE" || q.status === "SIMILAR" || q.status === "PRICE_ON_CONFIRMATION").length;

    const options: DeliveryOption[] = [];
    // Every shop can hand an order over the counter.
    options.push({ key: "PICKUP", feePaise: 0, etaMinutes: row.preparationTimeMinutes ?? 20 });
    if (s.deliversHere && row.deliveryAvailable && row.deliveryChoice !== "PICKUP_ONLY") {
      const fee = computeDeliveryFee(row, itemsPaise);
      const partner = row.deliveryChoice === "GOKESARI_PARTNER";
      options.push({ key: partner ? "GOKESARI_PARTNER" : "SHOP_DELIVERY", feePaise: fee, etaMinutes: eta(row.preparationTimeMinutes, s.distanceKm, partner) });
    }
    quotes.push({
      shopId: s.id,
      shopName: s.name,
      shopSlug: s.slug,
      area: s.area,
      distanceKm: s.distanceKm,
      rating: s.ratingCount > 0 ? s.ratingAvgX100 / 100 : null,
      ratingCount: s.ratingCount,
      available,
      total: items.length,
      missing: itemQuotes.filter((q) => q.status === "MISSING" || q.status === "LOW_STOCK").map((q) => q.itemId),
      itemsPaise,
      priceOnConfirmation: itemQuotes.filter((q) => q.status === "PRICE_ON_CONFIRMATION").length,
      deliveryOptions: options,
      cheapestTotalPaise: itemsPaise + Math.min(...options.map((o) => o.feePaise)),
      items: itemQuotes,
    });
  }
  // Shops with nothing from the list are left out.
  const useful = quotes.filter((q) => q.available > 0);
  useful.sort((a, b) => b.available - a.available || a.cheapestTotalPaise - b.cheapestTotalPaise);
  return { radiusKm: rule.comparisonRadiusKm, shops: useful, itemIds: items.map((i) => i.id), comparedAt };
}

/** Wishlist rows → comparison input. */
export function toWishItems(rows: (typeof smartWishlistItems.$inferSelect)[]): WishItem[] {
  return rows.map((r) => ({
    id: r.id,
    nameEn: r.nameEn,
    nameLocal: r.nameLocal,
    productId: r.productId,
    quantityAmount: Number(r.quantityAmount),
    quantityUnit: r.quantityUnit as BaseUnit,
  }));
}
