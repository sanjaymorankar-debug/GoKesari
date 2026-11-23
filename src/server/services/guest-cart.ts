/**
 * docs/guest-cart-2026-11 (owner, 23-Nov-2026): the server half of the guest
 * cart. A guest's lines live in their browser; here they are only
 *
 *  - priced (previewGuestCart) with the same live prices, offers and delivery
 *    fees as a signed-in cart (priceLines), nothing written; and
 *  - moved into the account cart after sign-in (mergeGuestCart). Owner rule:
 *    quantities are added to what the account cart already holds, capped at
 *    the per-line maximum and the shop's stock; a line that cannot be bought
 *    any more is dropped and named in the result.
 */
import { eq, inArray } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { GUEST_CART_MAX_LINES, type GuestCartLine } from "@/lib/guest-cart";
import { MAX_CART_LINE_QUANTITY, roundStock } from "@/lib/stock-quantity";
import { db } from "@/server/db";
import { cartItems, carts, productCategories, products, shopProducts, shops } from "@/server/db/schema";
import { addCartLine, priceLines, type CartSummary } from "./cart";

/** Repeats folded together (first wins), bad quantities removed, at most GUEST_CART_MAX_LINES. */
export function normaliseGuestLines(lines: GuestCartLine[]): GuestCartLine[] {
  const seen = new Set<string>();
  const out: GuestCartLine[] = [];
  for (const line of lines) {
    if (seen.has(line.shopProductId) || !(Number.isFinite(line.quantity) && line.quantity > 0)) continue;
    seen.add(line.shopProductId);
    out.push({ shopProductId: line.shopProductId, quantity: roundStock(Math.min(line.quantity, MAX_CART_LINE_QUANTITY)) });
    if (out.length >= GUEST_CART_MAX_LINES) break;
  }
  return out;
}

export interface GuestCartPreview extends Omit<CartSummary, "cartId"> {
  /** Lines whose listing no longer exists: the browser drops them. */
  missingShopProductIds: string[];
}

/** Prices a guest's lines like a cart (each line's cartItemId is its shopProductId). Reads only. */
export async function previewGuestCart(input: GuestCartLine[]): Promise<GuestCartPreview> {
  const lines = normaliseGuestLines(input);
  const ids = lines.map((l) => l.shopProductId);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({ sp: shopProducts, product: products, category: productCategories, shop: shops })
          .from(shopProducts)
          .innerJoin(products, eq(shopProducts.productId, products.id))
          .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
          .innerJoin(shops, eq(shopProducts.shopId, shops.id))
          .where(inArray(shopProducts.id, ids));
  const byId = new Map(rows.map((r) => [r.sp.id, r]));
  const priced = await priceLines(
    lines.flatMap((l) => {
      const row = byId.get(l.shopProductId);
      return row ? [{ lineId: l.shopProductId, quantity: l.quantity, ...row }] : [];
    }),
  );
  return { ...priced, missingShopProductIds: ids.filter((id) => !byId.has(id)) };
}

export interface GuestCartMergeResult {
  /** Lines added in full. */
  added: number;
  /** Lines added with less than asked (stock or the per-line maximum). */
  reduced: { shopProductId: string; productName: string | null; quantity: number }[];
  /** Lines not added, with the reason shown to the customer. */
  dropped: { shopProductId: string; productName: string | null; reason: string }[];
}

/**
 * Adds a guest's lines to the user's cart. Each line is its own short
 * transaction under the cart lock (addCartLine), so one bad line never loses
 * the others and a double submit cannot double-insert (the lock serialises).
 */
export async function mergeGuestCart(userId: string, input: GuestCartLine[]): Promise<GuestCartMergeResult> {
  const lines = normaliseGuestLines(input);
  const result: GuestCartMergeResult = { added: 0, reduced: [], dropped: [] };
  if (lines.length === 0) return result;

  const ids = lines.map((l) => l.shopProductId);
  const info = await db
    .select({ id: shopProducts.id, name: products.name, trackInventory: shopProducts.trackInventory, onlineStock: shopProducts.onlineStock })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(inArray(shopProducts.id, ids));
  const byId = new Map(info.map((r) => [r.id, r]));
  const existing = new Map(
    (
      await db
        .select({ shopProductId: cartItems.shopProductId, quantity: cartItems.quantity })
        .from(cartItems)
        .innerJoin(carts, eq(cartItems.cartId, carts.id))
        .where(eq(carts.userId, userId))
    ).map((r) => [r.shopProductId, r.quantity]),
  );

  for (const line of lines) {
    const listing = byId.get(line.shopProductId);
    if (!listing) {
      result.dropped.push({ shopProductId: line.shopProductId, productName: null, reason: "This item is no longer sold." });
      continue;
    }
    const already = existing.get(line.shopProductId) ?? 0;
    // Owner rule: add to what is there, capped at the per-line maximum and (when counted) the stock.
    let room = MAX_CART_LINE_QUANTITY - already;
    if (listing.trackInventory) room = Math.min(room, (listing.onlineStock ?? 0) - already);
    const quantity = roundStock(Math.min(line.quantity, room));
    if (quantity <= 0) {
      if (already > 0) {
        // Already in the cart as much as can be: nothing lost, nothing to add.
        result.reduced.push({ shopProductId: line.shopProductId, productName: listing.name, quantity: 0 });
      } else {
        result.dropped.push({ shopProductId: line.shopProductId, productName: listing.name, reason: "Out of stock." });
      }
      continue;
    }
    try {
      await addCartLine(userId, line.shopProductId, quantity);
      if (quantity < line.quantity) result.reduced.push({ shopProductId: line.shopProductId, productName: listing.name, quantity });
      else result.added += 1;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.dropped.push({ shopProductId: line.shopProductId, productName: listing.name, reason: error.message });
    }
  }
  return result;
}
