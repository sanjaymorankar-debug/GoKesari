/**
 * Home-page price comparison (feature F9).
 *
 * For a customer with a location, the products sold online by two or more of
 * the shops that deliver to them, each with every such shop's price (after
 * any live shop offer — what the cart would charge), cheapest first. Loose
 * goods without a price, out-of-stock and offline-only listings are left out.
 * Off (rule "homePriceComparison") → nothing is shown.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import { products, shopProducts, shops } from "@/server/db/schema";
import type { CustomerLocation } from "@/lib/location";
import { shopCarriesProductCategory } from "./product-categories";
import { serviceableShopIds } from "./serviceability";
import { getRule } from "./settings";
import { getLiveOffers, priceWithOffers } from "./shop-offers";

export interface ComparedPrice {
  shopProductId: string;
  shopId: string;
  shopName: string;
  shopSlug: string;
  pricePaise: number;
  /** The normal price, when a shop offer lowered it. */
  listPricePaise: number | null;
  distanceKm: number | null;
  cheapest: boolean;
}

export interface ComparedProduct {
  productId: string;
  productName: string;
  unit: string;
  unitSizeMilli: number;
  imageUrl: string | null;
  prices: ComparedPrice[];
  /** How much the dearest costs over the cheapest. */
  spreadPaise: number;
}

/** At most this many shops' prices are listed per product. */
const PRICES_SHOWN = 5;

/** What the comparison reads per listing — not whole product and shop-product rows. */
const listingColumns = {
  shopProductId: shopProducts.id,
  shopId: shopProducts.shopId,
  onlinePricePaise: shopProducts.onlinePricePaise,
  listingImageUrl: shopProducts.imageUrl,
  productId: products.id,
  categoryId: products.categoryId,
  productName: products.name,
  unit: products.unit,
  unitSizeMilli: products.unitSizeMilli,
  productImageUrl: products.imageUrl,
  shopName: shops.name,
  shopSlug: shops.slug,
};

/** Listings a customer could compare: bought online, priced, in stock, in a category the shop carries. */
function comparableListing(shopIds: string[]): SQL {
  return and(
    inArray(shopProducts.shopId, shopIds),
    eq(shops.status, "APPROVED"),
    isNull(shops.deletedAt),
    eq(shopProducts.isActive, true),
    isNull(shopProducts.deletedAt),
    eq(shopProducts.isAvailable, true),
    eq(shopProducts.onlineSaleEnabled, true),
    // Loose goods carry an empty price until the owner sets one — skipped.
    isNotNull(shopProducts.onlinePricePaise),
    gt(shopProducts.onlinePricePaise, 0),
    or(eq(shopProducts.trackInventory, false), gt(shopProducts.onlineStock, 0)),
    eq(products.isActive, true),
    shopCarriesProductCategory(shopProducts.shopId, products.categoryId),
  )!;
}

/** Every comparable listing at these shops — needed when offers can reorder products. */
function allListings(shopIds: string[]) {
  return db
    .select(listingColumns)
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(comparableListing(shopIds));
}

type Listing = Awaited<ReturnType<typeof allListings>>[number];

/**
 * Only the listings of the products that would rank in the top `limit` at
 * list price: the database ranks every product (the same order rankProducts
 * uses) and returns their listings alone, rather than the whole catalogue of
 * every nearby shop. Products tied on everything at the cut are separated by
 * the database's name order rather than localeCompare.
 */
function topListingsAtListPrice(shopIds: string[], limit: number): Promise<Listing[]> {
  const shopCount = sql`count(distinct ${shopProducts.shopId})`;
  const ranked = db.$with("ranked").as(
    db
      .select({ productId: shopProducts.productId })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .innerJoin(shops, eq(shops.id, shopProducts.shopId))
      .where(comparableListing(shopIds))
      .groupBy(shopProducts.productId, products.name)
      .having(sql`${shopCount} >= 2`)
      .orderBy(
        sql`least(${shopCount}, ${PRICES_SHOWN}) desc`,
        sql`max(${shopProducts.onlinePricePaise}) - min(${shopProducts.onlinePricePaise}) desc`,
        asc(products.name),
      )
      .limit(limit),
  );
  return db
    .with(ranked)
    .select(listingColumns)
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(
      and(
        comparableListing(shopIds),
        inArray(shopProducts.productId, db.select({ productId: ranked.productId }).from(ranked)),
      ),
    );
}

export async function homePriceComparison(
  location: CustomerLocation | null,
  options: { maxProducts?: number } = {},
): Promise<ComparedProduct[]> {
  if (!location) return [];
  const rule = await getRule("homePriceComparison");
  if (!rule.enabled) return [];
  const distances = await serviceableShopIds(location);
  if (distances.size < 2) return [];
  const shopIds = [...distances.keys()];
  const maxProducts = options.maxProducts ?? 6;

  // Without a live offer, list prices decide the ranking and the database can
  // pick the top products itself. An offer changes prices, and so the order,
  // so then every listing is priced here instead.
  const [offers, top] = await Promise.all([
    getLiveOffers(shopIds),
    topListingsAtListPrice(shopIds, maxProducts),
  ]);
  const listings = offers.length === 0 ? top : await allListings(shopIds);

  const byProduct = new Map<string, { listing: Listing; imageUrl: string | null; prices: ComparedPrice[] }>();
  for (const l of listings) {
    const priced = priceWithOffers(
      l.onlinePricePaise,
      { shopId: l.shopId, shopProductId: l.shopProductId, categoryId: l.categoryId },
      offers,
    );
    let entry = byProduct.get(l.productId);
    if (!entry) {
      entry = { listing: l, imageUrl: l.productImageUrl, prices: [] };
      byProduct.set(l.productId, entry);
    }
    entry.imageUrl ??= l.listingImageUrl;
    entry.prices.push({
      shopProductId: l.shopProductId,
      shopId: l.shopId,
      shopName: l.shopName,
      shopSlug: l.shopSlug,
      pricePaise: priced.unitPricePaise!,
      listPricePaise: priced.offer ? l.onlinePricePaise : null,
      distanceKm: distances.get(l.shopId) ?? null,
      cheapest: false,
    });
  }

  const compared: ComparedProduct[] = [];
  for (const { listing, imageUrl, prices } of byProduct.values()) {
    if (new Set(prices.map((p) => p.shopId)).size < 2) continue;
    prices.sort((a, b) => a.pricePaise - b.pricePaise || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const min = prices[0].pricePaise;
    for (const p of prices) p.cheapest = p.pricePaise === min;
    compared.push({
      productId: listing.productId,
      productName: listing.productName,
      unit: listing.unit,
      unitSizeMilli: listing.unitSizeMilli,
      imageUrl,
      prices: prices.slice(0, PRICES_SHOWN),
      spreadPaise: prices[prices.length - 1].pricePaise - min,
    });
  }
  // Most widely sold first, then the biggest saving, then by name.
  compared.sort(
    (a, b) => b.prices.length - a.prices.length || b.spreadPaise - a.spreadPaise || a.productName.localeCompare(b.productName),
  );
  return compared.slice(0, maxProducts);
}
