/**
 * docs/guest-checkout-2026-11: "Best shop for this cart". The cart's lines are turned into the
 * smart-shopping comparison's items and compared across nearby shops with the existing ranking
 * (services/smart-list/compare.ts: listings, pack sizes, stock, live offers, delivery fees). Here
 * the shops are then limited to those that deliver to the customer and ranked:
 *
 *   1. availability — most of the cart's items in stock (a complete cart first)
 *   2. price        — items + that shop's delivery fee
 *   3. distance     — nearer first
 *
 * A shop is suggested only when it has every item and is cheaper than the cart now, or when it has
 * every item and the cart now has lines that cannot be bought. Nothing is written: moving lines is
 * the customer's choice (POST /api/cart/recommendation/apply, or the browser cart for a guest).
 */
import { eq, inArray } from "drizzle-orm";

import { conflict } from "@/lib/errors";
import type { CustomerLocation } from "@/lib/location";
import { type BaseUnit, packInBase } from "@/lib/qty-words";
import { db } from "@/server/db";
import { products, shopProducts } from "@/server/db/schema";
import { addCartLine, getCart, removeCartItem, type CartSummary } from "@/server/services/cart";
import { compareWishlist, type ShopQuote, type WishItem } from "@/server/services/smart-list/compare";

export interface RecommendationLine {
  /** cart_items id for a signed-in cart, the shopProductId for a guest cart. */
  lineId: string;
  shopProductId: string;
  shopId: string;
  quantity: number;
  /** What the line costs now (0 when it cannot be bought). */
  lineTotalPaise: number;
  purchasable: boolean;
}

export interface LineProduct {
  productId: string;
  name: string;
  kind: string;
  unit: string;
  unitSizeMilli: number;
}

/** A cart line as a comparison item: the same product, the same amount in base units. */
export function lineToWishItem(line: RecommendationLine, product: LineProduct): WishItem | null {
  const pack = packInBase(product.unit, product.unitSizeMilli);
  if (!pack || !(line.quantity > 0)) return null;
  const amount = Math.round(pack.amount * line.quantity * 1000) / 1000;
  return {
    id: line.lineId,
    nameEn: product.name,
    nameLocal: null,
    productId: product.productId,
    quantityAmount: amount,
    quantityUnit: pack.unit as BaseUnit,
  };
}

export interface RankedShop {
  shopId: string;
  shopName: string;
  shopSlug: string;
  distanceKm: number | null;
  available: number;
  total: number;
  itemsPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  complete: boolean;
}

const DELIVERED = new Set(["SHOP_DELIVERY", "GOKESARI_PARTNER"]);

/** Serviceable shops only (they deliver here), ranked availability → price → distance. Pure. */
export function rankShopsForCart(quotes: ShopQuote[]): RankedShop[] {
  return quotes
    .map((q) => {
      const delivery = q.deliveryOptions.filter((o) => DELIVERED.has(o.key));
      if (delivery.length === 0) return null;
      const fee = Math.min(...delivery.map((o) => o.feePaise));
      // "Price on confirmation" lines have no price yet: they do not make a cart complete.
      const priced = q.items.filter((i) => (i.status === "AVAILABLE" || i.status === "SIMILAR") && i.linePaise != null).length;
      return {
        shopId: q.shopId,
        shopName: q.shopName,
        shopSlug: q.shopSlug,
        distanceKm: q.distanceKm,
        available: priced,
        total: q.total,
        itemsPaise: q.itemsPaise,
        deliveryFeePaise: fee,
        totalPaise: q.itemsPaise + fee,
        complete: priced === q.total && q.total > 0,
      } satisfies RankedShop;
    })
    .filter((r): r is RankedShop => r !== null)
    .sort(
      (a, b) =>
        b.available - a.available ||
        a.totalPaise - b.totalPaise ||
        (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY),
    );
}

export interface CartRecommendation {
  shop: RankedShop;
  /** What the cart costs now (items that can be bought + delivery of each shop). */
  currentTotalPaise: number;
  savingsPaise: number;
  /** The cart now has lines that cannot be bought; this shop has them all. */
  completesCart: boolean;
  /** Lines to move: from the cart line to this shop's listing and quantity. */
  moves: { lineId: string; fromShopProductId: string; toShopProductId: string; productName: string; quantity: number; similar: boolean }[];
}

/** Picks the suggestion from ranked shops and the quotes (for the moves). Pure. */
export function pickRecommendation(
  lines: RecommendationLine[],
  currentTotalPaise: number,
  ranked: RankedShop[],
  quotes: ShopQuote[],
): CartRecommendation | null {
  const best = ranked.find((r) => r.complete);
  if (!best) return null;
  const currentShops = new Set(lines.map((l) => l.shopId));
  const cartComplete = lines.every((l) => l.purchasable);
  const savingsPaise = currentTotalPaise - best.totalPaise;
  const alreadyThere = currentShops.size === 1 && currentShops.has(best.shopId);
  if (alreadyThere) return null;
  const completesCart = !cartComplete;
  if (!(savingsPaise > 0) && !completesCart) return null;
  const quote = quotes.find((q) => q.shopId === best.shopId);
  if (!quote) return null;
  const moves = quote.items.flatMap((i) => {
    const line = lines.find((l) => l.lineId === i.itemId);
    if (!line || !i.shopProductId || i.shopProductId === line.shopProductId) return [];
    return [
      {
        lineId: line.lineId,
        fromShopProductId: line.shopProductId,
        toShopProductId: i.shopProductId,
        productName: i.productName ?? "",
        quantity: i.cartQuantity,
        similar: i.status === "SIMILAR",
      },
    ];
  });
  if (moves.length === 0) return null;
  return { shop: best, currentTotalPaise, savingsPaise: Math.max(0, savingsPaise), completesCart, moves };
}

/** The suggestion for these cart lines at this location, or null. Reads only. */
export async function recommendShopForCart(
  lines: RecommendationLine[],
  currentTotalPaise: number,
  location: CustomerLocation | null,
): Promise<CartRecommendation | null> {
  if (!location || lines.length === 0) return null;
  const rows = await db
    .select({
      shopProductId: shopProducts.id,
      productId: products.id,
      name: products.name,
      kind: products.kind,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(inArray(shopProducts.id, lines.map((l) => l.shopProductId)));
  const bySp = new Map(rows.map((r) => [r.shopProductId, r]));
  const items = lines.flatMap((l) => {
    const p = bySp.get(l.shopProductId);
    const item = p ? lineToWishItem(l, p) : null;
    return item ? [item] : [];
  });
  // Every line must be comparable, or "complete" would mean less than the cart.
  if (items.length !== lines.length) return null;
  const comparison = await compareWishlist(items, location);
  return pickRecommendation(lines, currentTotalPaise, rankShopsForCart(comparison.shops), comparison.shops);
}

/** A priced cart (signed-in, or a guest preview where each line's id is its shopProductId) as recommendation lines. */
export function linesFromSummary(summary: Pick<CartSummary, "groups">): RecommendationLine[] {
  return summary.groups.flatMap((g) =>
    g.lines.map((l) => ({
      lineId: l.cartItemId,
      shopProductId: l.shopProductId,
      shopId: g.shop.id,
      quantity: l.quantity,
      lineTotalPaise: l.purchasable ? l.lineTotalPaise : 0,
      purchasable: l.purchasable,
    })),
  );
}

/** The suggestion for a signed-in customer's own cart. */
export async function recommendForUserCart(userId: string, location: CustomerLocation | null): Promise<CartRecommendation | null> {
  const cart = await getCart(userId);
  return recommendShopForCart(linesFromSummary(cart), cart.grandTotalPaise, location);
}

/**
 * Moves a signed-in customer's lines to the suggested shop. The suggestion is worked out again
 * here (nothing from the browser is trusted) and must still be for `shopId`. New lines are added
 * first (each checked for stock like any add), then the old lines removed.
 */
export async function applyRecommendationForUser(
  userId: string,
  shopId: string,
  location: CustomerLocation | null,
): Promise<{ moved: number }> {
  const rec = await recommendForUserCart(userId, location);
  if (!rec || rec.shop.shopId !== shopId) {
    throw conflict("This suggestion has changed. Look at the cart again.");
  }
  for (const move of rec.moves) await addCartLine(userId, move.toShopProductId, move.quantity);
  for (const move of rec.moves) await removeCartItem(userId, move.lineId);
  return { moved: rec.moves.length };
}
