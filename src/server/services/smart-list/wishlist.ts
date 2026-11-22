/**
 * The customer's saved wishlists from photo lists (docs/smart-shopping-2026-11, Feature 1 §3 and §5).
 *
 * Saved on the customer's account with the scan (photo) reference so it can be
 * reused or re-ordered. "Order from this shop" re-prices the wishlist at that
 * shop now (so a change since the comparison is caught), puts the available
 * items in the ordinary cart (addToCart: the normal checkout, payment and
 * fulfilment flow then runs unchanged), and marks the rest NOT_ORDERED so the
 * customer can order them from another shop later.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { notFound, validationFailed } from "@/lib/errors";
import type { CustomerLocation } from "@/lib/location";
import { QUANTITY_UNITS } from "@/lib/smart-list";
import { db } from "@/server/db";
import { products, shoppingListScans, smartWishlistItems, smartWishlists } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { requireFeature } from "@/server/services/feature-flags";
import { type Comparison, compareWishlist, toWishItems } from "./compare";
import { SCAN_FLAG } from "./scan";

export const MAX_ITEMS = 100;
export const MAX_WISHLISTS = 50;

export const itemInputSchema = z.object({
  originalText: z.string().max(300).nullable().optional(),
  originalLang: z.string().max(8).nullable().optional(),
  nameEn: z.string().trim().min(1).max(120),
  nameLocal: z.string().trim().max(120).nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  /** What the AI matched first (from the scan), for accuracy. */
  aiProductId: z.string().uuid().nullable().optional(),
  matchConfidence: z.number().int().min(0).max(100).nullable().optional(),
  quantityAmount: z.number().positive().max(100_000),
  quantityUnit: z.enum(QUANTITY_UNITS as [string, ...string[]]),
  userEdited: z.boolean().optional(),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

async function assertProductsExist(ids: (string | null | undefined)[]): Promise<void> {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (wanted.length === 0) return;
  const found = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, wanted), eq(products.isActive, true), eq(products.approvalStatus, "APPROVED")));
  if (found.length !== wanted.length) throw validationFailed("One of the chosen products is no longer available. Choose it again.");
}

function rowOf(wishlistId: string, item: ItemInput, position: number) {
  const productChanged = (item.productId ?? null) !== (item.aiProductId ?? null);
  return {
    wishlistId,
    position,
    originalText: item.originalText ?? null,
    originalLang: item.originalLang ?? null,
    nameEn: item.nameEn,
    nameLocal: item.nameLocal ?? null,
    productId: item.productId ?? null,
    aiProductId: item.aiProductId ?? null,
    matchConfidence: item.productId && !productChanged ? (item.matchConfidence ?? null) : null,
    userEdited: Boolean(item.userEdited) || productChanged,
    quantityAmount: String(item.quantityAmount),
    quantityUnit: item.quantityUnit,
  };
}

export async function saveWishlist(userId: string, input: { name?: string; scanId?: string | null; items: ItemInput[] }): Promise<{ id: string }> {
  await requireFeature(SCAN_FLAG);
  if (input.items.length === 0) throw validationFailed("Add at least one item to the wishlist.");
  if (input.items.length > MAX_ITEMS) throw validationFailed(`A wishlist can have at most ${MAX_ITEMS} items.`);
  await assertProductsExist(input.items.map((i) => i.productId));
  if (input.scanId) {
    const scan = await db.query.shoppingListScans.findFirst({ where: and(eq(shoppingListScans.id, input.scanId), eq(shoppingListScans.userId, userId)) });
    if (!scan) throw notFound("Scan");
  }
  const name = (input.name ?? "").trim() || `My list ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}`;
  return db.transaction(async (tx) => {
    const count = await tx.$count(smartWishlists, and(eq(smartWishlists.userId, userId), isNull(smartWishlists.deletedAt)));
    if (count >= MAX_WISHLISTS) throw validationFailed(`You can keep up to ${MAX_WISHLISTS} wishlists. Delete an old one first.`);
    const [list] = await tx.insert(smartWishlists).values({ userId, scanId: input.scanId ?? null, name: name.slice(0, 80) }).returning({ id: smartWishlists.id });
    await tx.insert(smartWishlistItems).values(input.items.map((item, i) => rowOf(list.id, item, i)));
    return { id: list.id };
  });
}

async function ownList(userId: string, id: string) {
  const list = await db.query.smartWishlists.findFirst({
    where: and(eq(smartWishlists.id, id), eq(smartWishlists.userId, userId), isNull(smartWishlists.deletedAt)),
  });
  if (!list) throw notFound("Wishlist");
  return list;
}

export async function listWishlists(userId: string) {
  return db
    .select({ id: smartWishlists.id, name: smartWishlists.name, scanId: smartWishlists.scanId, updatedAt: smartWishlists.updatedAt, items: db.$count(smartWishlistItems, eq(smartWishlistItems.wishlistId, smartWishlists.id)) })
    .from(smartWishlists)
    .where(and(eq(smartWishlists.userId, userId), isNull(smartWishlists.deletedAt)))
    .orderBy(desc(smartWishlists.updatedAt))
    .limit(MAX_WISHLISTS);
}

export async function getWishlist(userId: string, id: string) {
  const list = await ownList(userId, id);
  const items = await db.select().from(smartWishlistItems).where(eq(smartWishlistItems.wishlistId, id)).orderBy(asc(smartWishlistItems.position));
  const productIds = items.map((i) => i.productId).filter((x): x is string => Boolean(x));
  const names = productIds.length
    ? await db.select({ id: products.id, name: products.name, imageUrl: products.imageUrl }).from(products).where(inArray(products.id, productIds))
    : [];
  const byId = new Map(names.map((p) => [p.id, p]));
  return {
    ...list,
    items: items.map((i) => ({ ...i, quantityAmount: Number(i.quantityAmount), product: i.productId ? (byId.get(i.productId) ?? null) : null })),
  };
}

/** Replaces the items (the review screen saves the whole list) and/or renames. */
export async function updateWishlist(userId: string, id: string, input: { name?: string; items?: ItemInput[] }): Promise<void> {
  await ownList(userId, id);
  if (input.items) {
    if (input.items.length === 0) throw validationFailed("Add at least one item, or delete the wishlist.");
    if (input.items.length > MAX_ITEMS) throw validationFailed(`A wishlist can have at most ${MAX_ITEMS} items.`);
    await assertProductsExist(input.items.map((i) => i.productId));
  }
  await db.transaction(async (tx) => {
    await tx
      .update(smartWishlists)
      .set({ ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}), updatedAt: new Date() })
      .where(eq(smartWishlists.id, id));
    if (input.items) {
      await tx.delete(smartWishlistItems).where(eq(smartWishlistItems.wishlistId, id));
      await tx.insert(smartWishlistItems).values(input.items.map((item, i) => rowOf(id, item, i)));
    }
  });
}

export async function deleteWishlist(userId: string, id: string): Promise<void> {
  await ownList(userId, id);
  await db.update(smartWishlists).set({ deletedAt: new Date() }).where(eq(smartWishlists.id, id));
}

export async function compareSavedWishlist(userId: string, id: string, location: CustomerLocation, onlyPending = false): Promise<Comparison> {
  await requireFeature(SCAN_FLAG);
  await ownList(userId, id);
  const rows = await db.select().from(smartWishlistItems).where(eq(smartWishlistItems.wishlistId, id)).orderBy(asc(smartWishlistItems.position));
  const items = toWishItems(onlyPending ? rows.filter((r) => r.status !== "IN_CART" && r.status !== "ORDERED") : rows);
  return compareWishlist(items, location);
}

export interface OrderFromShopResult {
  added: { itemId: string; productName: string; quantity: number; linePaise: number | null }[];
  notAdded: { itemId: string; name: string; reason: string }[];
  /** Price or availability that moved since the comparison the customer saw. */
  changes: { itemId: string; name: string; before: number | null; now: number | null; note: string }[];
}

/**
 * Puts the wishlist's available items from one shop into the cart. `seen` is what the customer's comparison
 * showed per item (line price in paise, null = not available), so a change since then is reported before
 * payment. Checkout re-checks stock and prices again, as always.
 */
export async function orderFromShop(
  userId: string,
  id: string,
  shopId: string,
  location: CustomerLocation,
  seen: Record<string, number | null> = {},
): Promise<OrderFromShopResult> {
  await requireFeature(SCAN_FLAG);
  await ownList(userId, id);
  const rows = await db.select().from(smartWishlistItems).where(eq(smartWishlistItems.wishlistId, id)).orderBy(asc(smartWishlistItems.position));
  const pending = rows.filter((r) => r.status !== "IN_CART" && r.status !== "ORDERED");
  const fresh = await compareWishlist(toWishItems(pending), location);
  const shop = fresh.shops.find((s) => s.shopId === shopId);
  if (!shop) throw validationFailed("This shop no longer has any item of your list near you. Compare again.");

  const result: OrderFromShopResult = { added: [], notAdded: [], changes: [] };
  const nameOf = new Map(pending.map((r) => [r.id, r.nameEn]));
  const now = new Date();
  for (const q of shop.items) {
    const name = nameOf.get(q.itemId) ?? "";
    const before = q.itemId in seen ? seen[q.itemId] : undefined;
    const nowLine = q.status === "AVAILABLE" || q.status === "SIMILAR" ? q.linePaise : null;
    if (before !== undefined && before !== nowLine) {
      result.changes.push({
        itemId: q.itemId,
        name,
        before,
        now: nowLine,
        note: nowLine == null ? "No longer available" : before == null ? "Now available" : nowLine > before ? "Price went up" : "Price went down",
      });
    }
    if ((q.status === "AVAILABLE" || q.status === "SIMILAR") && q.shopProductId) {
      try {
        await addToCart(userId, q.shopProductId, q.cartQuantity);
        result.added.push({ itemId: q.itemId, productName: q.productName ?? name, quantity: q.cartQuantity, linePaise: q.linePaise });
        await db.update(smartWishlistItems).set({ status: "IN_CART", lastShopId: shopId, updatedAt: now }).where(eq(smartWishlistItems.id, q.itemId));
        continue;
      } catch (e) {
        result.notAdded.push({ itemId: q.itemId, name, reason: e instanceof Error ? e.message : "Could not be added" });
      }
    } else {
      result.notAdded.push({
        itemId: q.itemId,
        name,
        reason: q.status === "PRICE_ON_CONFIRMATION" ? "The shop prices this on confirmation" : q.status === "LOW_STOCK" ? "Not enough in stock" : "Not sold by this shop",
      });
    }
    await db.update(smartWishlistItems).set({ status: "NOT_ORDERED", updatedAt: now }).where(eq(smartWishlistItems.id, q.itemId));
  }
  await db.update(smartWishlists).set({ updatedAt: now }).where(eq(smartWishlists.id, id));
  return result;
}

/** Puts every item back to "to buy" (e.g. to re-order the same list next month). */
export async function resetWishlistStatus(userId: string, id: string): Promise<void> {
  await ownList(userId, id);
  await db.update(smartWishlistItems).set({ status: "PENDING", updatedAt: new Date() }).where(eq(smartWishlistItems.wishlistId, id));
}
