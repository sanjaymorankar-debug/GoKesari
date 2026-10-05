/**
 * Home-page price comparison (feature F9).
 *
 * For a customer with a location, the products sold online by two or more of
 * the shops that deliver to them, each with every such shop's price (after
 * any live shop offer — what the cart would charge), cheapest first. Loose
 * goods without a price, out-of-stock and offline-only listings are left out.
 * Off (rule "homePriceComparison") → nothing is shown.
 */
import { and, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";

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

export async function homePriceComparison(
  location: CustomerLocation | null,
  options: { maxProducts?: number } = {},
): Promise<ComparedProduct[]> {
  const rule = await getRule("homePriceComparison");
  if (!rule.enabled || !location) return [];
  const distances = await serviceableShopIds(location);
  if (distances.size < 2) return [];
  const shopIds = [...distances.keys()];

  const rows = await db
    .select({ sp: shopProducts, product: products, shop: { id: shops.id, name: shops.name, slug: shops.slug } })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(
      and(
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
      ),
    );

  const offers = await getLiveOffers(shopIds);
  const byProduct = new Map<string, { product: (typeof rows)[number]["product"]; imageUrl: string | null; prices: ComparedPrice[] }>();
  for (const r of rows) {
    const priced = priceWithOffers(
      r.sp.onlinePricePaise,
      { shopId: r.shop.id, shopProductId: r.sp.id, categoryId: r.product.categoryId },
      offers,
    );
    let entry = byProduct.get(r.product.id);
    if (!entry) {
      entry = { product: r.product, imageUrl: r.product.imageUrl, prices: [] };
      byProduct.set(r.product.id, entry);
    }
    entry.imageUrl ??= r.sp.imageUrl;
    entry.prices.push({
      shopProductId: r.sp.id,
      shopId: r.shop.id,
      shopName: r.shop.name,
      shopSlug: r.shop.slug,
      pricePaise: priced.unitPricePaise!,
      listPricePaise: priced.offer ? r.sp.onlinePricePaise : null,
      distanceKm: distances.get(r.shop.id) ?? null,
      cheapest: false,
    });
  }

  const compared: ComparedProduct[] = [];
  for (const { product, imageUrl, prices } of byProduct.values()) {
    if (new Set(prices.map((p) => p.shopId)).size < 2) continue;
    prices.sort((a, b) => a.pricePaise - b.pricePaise || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const min = prices[0].pricePaise;
    for (const p of prices) p.cheapest = p.pricePaise === min;
    compared.push({
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      unitSizeMilli: product.unitSizeMilli,
      imageUrl,
      prices: prices.slice(0, 5),
      spreadPaise: prices[prices.length - 1].pricePaise - min,
    });
  }
  // Most widely sold first, then the biggest saving, then by name.
  compared.sort(
    (a, b) => b.prices.length - a.prices.length || b.spreadPaise - a.spreadPaise || a.productName.localeCompare(b.productName),
  );
  return compared.slice(0, options.maxProducts ?? 6);
}
