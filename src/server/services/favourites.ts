/**
 * Favourites (docs/search-brand-barcode-favourites-2026-11, flag brand_barcode_favourites_enabled):
 * a customer's saved catalogue products — the heart on a product card — shown on /favourites with
 * the lowest price near them and "Add to cart". Not the smart-list "wishlist" (services/smart-list).
 *
 * `favourites.product_id` has no foreign key (catalogue side): every write checks the product exists,
 * is active and approved; a product that is later removed shows as "no longer sold" and can be removed.
 * A guest's hearts live in their browser and are merged here once at sign-in (mergeFavourites).
 * Personal, low-value data — like the cart, changes are not audit-logged.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { brands, favourites, products } from "@/server/db/schema";
import { lowestOffersForProducts, type LowestOffer } from "./catalogue";
import { packSizeText } from "./product-barcode-search";

/** Most products one account may keep. */
export const MAX_FAVOURITES = 500;
/** Most guest hearts merged in one sign-in (a browser keeps at most this many). */
export const MAX_GUEST_MERGE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid, distinct product ids (anything else in a guest's browser storage is dropped). */
export function cleanProductIds(raw: readonly unknown[], max = MAX_GUEST_MERGE): string[] {
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && UUID.test(v)) out.add(v.toLowerCase());
    if (out.size >= max) break;
  }
  return [...out];
}

/** Which of these products exist, are active and approved — the only ones a customer may save. */
async function savableProductIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, [...ids]), eq(products.isActive, true), isNull(products.deletedAt), eq(products.approvalStatus, "APPROVED")));
  return new Set(rows.map((r) => r.id));
}

async function countFavourites(userId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(favourites).where(eq(favourites.userId, userId));
  return Number(row?.n ?? 0);
}

/** The customer's saved product ids, newest first (the hearts). */
export async function listFavouriteIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ productId: favourites.productId })
    .from(favourites)
    .where(eq(favourites.userId, userId))
    .orderBy(desc(favourites.createdAt))
    .limit(MAX_FAVOURITES);
  return rows.map((r) => r.productId);
}

/** Saves a product. Saving one already saved changes nothing. */
export async function addFavourite(userId: string, productId: string): Promise<{ added: boolean }> {
  const id = cleanProductIds([productId], 1)[0];
  if (!id || !(await savableProductIds([id])).has(id)) throw notFound("Product");
  const [existing] = await db
    .select({ productId: favourites.productId })
    .from(favourites)
    .where(and(eq(favourites.userId, userId), eq(favourites.productId, id)));
  if (existing) return { added: false };
  if ((await countFavourites(userId)) >= MAX_FAVOURITES) {
    throw conflict(`You can keep up to ${MAX_FAVOURITES} favourites. Remove some to add more.`, { reason: "FAVOURITES_FULL" });
  }
  const inserted = await db.insert(favourites).values({ userId, productId: id }).onConflictDoNothing().returning({ productId: favourites.productId });
  return { added: inserted.length > 0 };
}

/** Removes a product from favourites. Removing one not saved changes nothing. */
export async function removeFavourite(userId: string, productId: string): Promise<{ removed: boolean }> {
  const id = cleanProductIds([productId], 1)[0];
  if (!id) return { removed: false };
  const deleted = await db
    .delete(favourites)
    .where(and(eq(favourites.userId, userId), eq(favourites.productId, id)))
    .returning({ productId: favourites.productId });
  return { removed: deleted.length > 0 };
}

/**
 * A guest's hearts, moved to the account at sign-in. Unknown, removed or unapproved products are
 * skipped; products already saved stay as they are; the account's limit is respected (the rest are
 * skipped, not an error). Returns how many were added and the account's ids afterwards.
 */
export async function mergeFavourites(userId: string, rawIds: readonly unknown[]): Promise<{ added: number; skipped: number; ids: string[] }> {
  const ids = cleanProductIds(rawIds);
  const savable = await savableProductIds(ids);
  const current = new Set(await listFavouriteIds(userId));
  const room = Math.max(0, MAX_FAVOURITES - current.size);
  const fresh = ids.filter((id) => savable.has(id) && !current.has(id)).slice(0, room);
  let added = 0;
  if (fresh.length > 0) {
    const inserted = await db
      .insert(favourites)
      .values(fresh.map((productId) => ({ userId, productId })))
      .onConflictDoNothing()
      .returning({ productId: favourites.productId });
    added = inserted.length;
  }
  return { added, skipped: rawIds.length - added, ids: await listFavouriteIds(userId) };
}

export interface FavouriteView {
  productId: string;
  name: string;
  brandName: string | null;
  brandSlug: string | null;
  imageUrl: string | null;
  packSize: string;
  mrpPaise: number | null;
  /** The product was removed from the catalogue (or switched off): nothing to buy. */
  gone: boolean;
  /**
   * The cheapest buyable listing (near the customer when they have a location, else anywhere),
   * else the cheapest Live one; null when no shop sells it.
   */
  best: Pick<LowestOffer, "shopProductId" | "shopName" | "shopSlug" | "onlinePricePaise" | "offlinePricePaise" | "buyable" | "shopCount"> | null;
  /** Whether `best` is limited to the shops that deliver to the customer. */
  nearby: boolean;
  savedAt: string | null;
}

/**
 * Favourites with what they cost now. `userId` for an account's list (newest first); `productIds` for
 * a guest's browser list (in the order given). `shopIds`: the shops delivering to the customer.
 */
export async function describeFavourites(
  source: { userId: string } | { productIds: readonly unknown[] },
  options: { shopIds?: readonly string[] } = {},
): Promise<FavouriteView[]> {
  let order: { productId: string; savedAt: Date | null }[];
  if ("userId" in source) {
    order = await db
      .select({ productId: favourites.productId, savedAt: favourites.createdAt })
      .from(favourites)
      .where(eq(favourites.userId, source.userId))
      .orderBy(desc(favourites.createdAt))
      .limit(MAX_FAVOURITES);
  } else {
    order = cleanProductIds(source.productIds).map((productId) => ({ productId, savedAt: null }));
  }
  if (order.length === 0) return [];
  const ids = order.map((o) => o.productId);
  const [rows, offers] = await Promise.all([
    db
      .select({
        id: products.id,
        name: products.name,
        imageUrl: products.imageUrl,
        unit: products.unit,
        unitSizeMilli: products.unitSizeMilli,
        netQuantity: products.netQuantity,
        netQuantityUnit: products.netQuantityUnit,
        mrpPaise: products.mrpPaise,
        isActive: products.isActive,
        deletedAt: products.deletedAt,
        approvalStatus: products.approvalStatus,
        brandName: brands.name,
        brandSlug: brands.slug,
        brandLive: sql<boolean>`(${brands.isActive} AND ${brands.deletedAt} IS NULL)`,
      })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(inArray(products.id, ids)),
    lowestOffersForProducts(ids, { shopIds: options.shopIds }),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FavouriteView[] = [];
  for (const { productId, savedAt } of order) {
    const p = byId.get(productId);
    // A guest's browser may hold an id that never existed: drop it. An account's row shows as gone.
    if (!p && !("userId" in source)) continue;
    const gone = !p || !p.isActive || p.deletedAt != null || p.approvalStatus !== "APPROVED";
    const offer = gone ? undefined : offers.get(productId);
    out.push({
      productId,
      name: p?.name ?? "Product no longer sold",
      brandName: p?.brandLive ? p.brandName : null,
      brandSlug: p?.brandLive ? p.brandSlug : null,
      imageUrl: p?.imageUrl ?? null,
      packSize: p ? packSizeText(p) : "",
      mrpPaise: p?.mrpPaise ?? null,
      gone,
      best: offer
        ? {
            shopProductId: offer.shopProductId,
            shopName: offer.shopName,
            shopSlug: offer.shopSlug,
            onlinePricePaise: offer.onlinePricePaise,
            offlinePricePaise: offer.offlinePricePaise,
            buyable: offer.buyable,
            shopCount: offer.shopCount,
          }
        : null,
      nearby: Boolean(options.shopIds),
      savedAt: savedAt ? savedAt.toISOString() : null,
    });
  }
  return out;
}
