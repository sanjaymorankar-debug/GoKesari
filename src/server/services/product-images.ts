/**
 * Product image management: several photos per product or per shop listing,
 * one primary, an order, replacement and deletion.
 *
 * Scope: `shopProductId` null → the product's own photos (catalogue staff, or
 * the shop owner who created the product); set → that shop's listing (its owner
 * or staff). The primary photo's URL is mirrored to `products.image_url` /
 * `shop_products.image_url`, so every existing reader keeps working and a
 * listing's own primary photo wins for that shop.
 *
 * Files themselves are validated and stored by image-store.ts (type, size,
 * pixel limits); this module never touches file bytes.
 *
 * F10 moderation: with rule "imageModeration" on, a photo a shop owner adds or
 * replaces is PENDING until an admin approves it. Only APPROVED photos are
 * shown publicly or mirrored to the image_url columns; staff uploads and every
 * photo from before F10 are APPROVED.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  productImages,
  products,
  shopProducts,
  shops,
  storedImages,
  type ProductImage,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { listShopProducts } from "./catalogue";
import { scheduleOrphanSweep } from "@/server/media/blob-store";
import { imageUrl, storageKeysOf } from "./image-store";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

const isStaff = (role: UserRole) => role === "OPERATOR" || role === "ADMIN";

const scopeWhere = (productId: string, shopProductId: string | null) =>
  shopProductId
    ? and(eq(productImages.productId, productId), eq(productImages.shopProductId, shopProductId))
    : and(eq(productImages.productId, productId), isNull(productImages.shopProductId));

/** Photos in one scope, primary first then by order (with `approvedOnly`, only publicly visible ones). */
export async function listImages(
  productId: string,
  shopProductId: string | null = null,
  client: DbClient = db,
  options: { approvedOnly?: boolean } = {},
): Promise<ProductImage[]> {
  return client
    .select()
    .from(productImages)
    .where(
      options.approvedOnly
        ? and(scopeWhere(productId, shopProductId), eq(productImages.moderationStatus, "APPROVED"))
        : scopeWhere(productId, shopProductId),
    )
    .orderBy(sql`${productImages.isPrimary} DESC`, asc(productImages.sortOrder), asc(productImages.createdAt));
}

/** What a page shows: the listing's own approved photos if it has any, else the product's. */
export async function galleryFor(productId: string, shopProductId?: string | null): Promise<ProductImage[]> {
  if (shopProductId) {
    const own = await listImages(productId, shopProductId, db, { approvedOnly: true });
    if (own.length > 0) return own;
  }
  return listImages(productId, null, db, { approvedOnly: true });
}

/** Whether `actor` may manage (and so see unapproved) photos in this scope. */
export async function canManageImages(actor: Actor | null, productId: string, shopProductId: string | null): Promise<boolean> {
  if (!actor) return false;
  try {
    await assertMayManage(actor, productId, shopProductId);
    return true;
  } catch {
    return false;
  }
}

/** PENDING when moderation is on and a non-staff user adds or replaces a photo. */
export async function initialStatus(actor: Actor): Promise<"PENDING" | "APPROVED"> {
  if (isStaff(actor.role)) return "APPROVED";
  return (await getRule("imageModeration")).enabled ? "PENDING" : "APPROVED";
}

async function assertMayManage(actor: Actor, productId: string, shopProductId: string | null): Promise<void> {
  const [product] = await db.select().from(products).where(eq(products.id, productId));
  if (!product) throw notFound("Product");
  if (shopProductId) {
    const [row] = await db
      .select({ productId: shopProducts.productId, ownerId: shops.ownerId })
      .from(shopProducts)
      .innerJoin(shops, eq(shopProducts.shopId, shops.id))
      .where(eq(shopProducts.id, shopProductId));
    if (!row || row.productId !== productId) throw notFound("Listing");
    if (row.ownerId !== actor.id && !isStaff(actor.role)) throw forbidden("This listing does not belong to you.");
    return;
  }
  if (!isStaff(actor.role) && product.createdBy !== actor.id) {
    throw forbidden("Only catalogue staff, or the shop that created this product, can change its photos.");
  }
}

/**
 * Keeps products.image_url / shop_products.image_url equal to the primary
 * photo — the primary approved one (F10), else the next approved in order.
 * Without moderation every photo is approved, so this is the primary as before.
 */
export async function syncPrimary(tx: DbClient, productId: string, shopProductId: string | null): Promise<void> {
  const [primary] = await listImages(productId, shopProductId, tx, { approvedOnly: true });
  if (shopProductId) {
    await tx.update(shopProducts).set({ imageUrl: primary?.url ?? null, updatedAt: new Date() }).where(eq(shopProducts.id, shopProductId));
  } else {
    await tx.update(products).set({ imageUrl: primary?.url ?? null }).where(eq(products.id, productId));
  }
}

/**
 * Deletes an uploaded file once no photo row points at it. A file kept on
 * disk (Module 1) is removed shortly after the transaction commits, and only
 * if nothing refers to it by then.
 */
export async function dropIfOrphaned(tx: DbClient, storedImageId: string | null): Promise<void> {
  if (!storedImageId) return;
  const [ref] = await tx
    .select({ id: productImages.id })
    .from(productImages)
    .where(eq(productImages.storedImageId, storedImageId))
    .limit(1);
  if (ref) return;
  const keys = await storageKeysOf(storedImageId, tx);
  await tx.delete(storedImages).where(eq(storedImages.id, storedImageId));
  scheduleOrphanSweep(keys);
}

/** How many photos a scope may hold: a shop listing's own limit (Module 1), else the catalogue's. */
export async function photoLimitFor(shopProductId: string | null): Promise<number> {
  return shopProductId ? (await getRule("shopProductMedia")).maxPhotos : (await getRule("images")).maxPerProduct;
}

async function loadUploaded(tx: DbClient, storedImageId: string, actor: Actor) {
  const [img] = await tx.select().from(storedImages).where(eq(storedImages.id, storedImageId));
  if (!img || img.purpose !== "PRODUCT") throw validationFailed("That upload cannot be used as a product photo.");
  if (img.ownerId !== actor.id && !isStaff(actor.role)) throw forbidden("That upload is not yours.");
  return img;
}

export async function addImage(
  input: { productId: string; shopProductId?: string | null; storedImageId: string; altText?: string | null },
  actor: Actor,
): Promise<ProductImage> {
  const shopProductId = input.shopProductId ?? null;
  await assertMayManage(actor, input.productId, shopProductId);
  const maxPhotos = await photoLimitFor(shopProductId);
  const moderationStatus = await initialStatus(actor);

  return db.transaction(async (tx) => {
    const img = await loadUploaded(tx, input.storedImageId, actor);
    const existing = await listImages(input.productId, shopProductId, tx);
    if (existing.length >= maxPhotos) {
      throw validationFailed(`At most ${maxPhotos} photos can be kept here. Delete one first.`);
    }
    if (existing.some((e) => e.storedImageId === img.id)) throw conflict("That photo is already added.");

    const [row] = await tx
      .insert(productImages)
      .values({
        productId: input.productId,
        shopProductId,
        storedImageId: img.id,
        url: imageUrl(img.id),
        altText: input.altText?.trim() || null,
        // The first photo of a scope is its primary.
        isPrimary: existing.length === 0,
        sortOrder: existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1,
        createdBy: actor.id,
        moderationStatus,
      })
      .returning();
    await syncPrimary(tx, input.productId, shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product_image",
        entityId: row.id,
        newValue: { change: "added", productId: input.productId, shopProductId, primary: row.isPrimary, moderationStatus },
      },
      tx,
    );
    return row;
  });
}

async function loadImage(tx: DbClient, imageId: string, productId: string): Promise<ProductImage> {
  const [row] = await tx.select().from(productImages).where(eq(productImages.id, imageId));
  if (!row || row.productId !== productId) throw notFound("Photo");
  return row;
}

export async function setPrimaryImage(productId: string, imageId: string, actor: Actor): Promise<void> {
  const [probe] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    if (row.isPrimary) return;
    // Demote first so the one-primary-per-scope index is never violated.
    await tx
      .update(productImages)
      .set({ isPrimary: false })
      .where(and(scopeWhere(productId, row.shopProductId), eq(productImages.isPrimary, true)));
    await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, imageId));
    await syncPrimary(tx, productId, row.shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product_image",
        entityId: imageId,
        newValue: { change: "primary" },
      },
      tx,
    );
  });
}

/** Sets the display order; `orderedIds` must be exactly the scope's current photos. */
export async function reorderImages(
  productId: string,
  shopProductId: string | null,
  orderedIds: string[],
  actor: Actor,
): Promise<void> {
  await assertMayManage(actor, productId, shopProductId);
  await db.transaction(async (tx) => {
    const current = await listImages(productId, shopProductId, tx);
    const same =
      current.length === orderedIds.length &&
      new Set(orderedIds).size === orderedIds.length &&
      current.every((c) => orderedIds.includes(c.id));
    if (!same) throw validationFailed("The new order must list each photo exactly once.");
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(productImages).set({ sortOrder: index }).where(eq(productImages.id, id));
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product",
        entityId: productId,
        newValue: { change: "reordered", shopProductId, order: orderedIds },
      },
      tx,
    );
  });
}

/** Swaps the file behind a photo, keeping its place and primary flag; the old file is deleted if unused. */
export async function replaceImage(
  productId: string,
  imageId: string,
  storedImageId: string,
  actor: Actor,
): Promise<ProductImage> {
  const [probe] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  return db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    const img = await loadUploaded(tx, storedImageId, actor);
    // F10: a replaced photo is a new photo — it waits for review like one.
    const moderationStatus = await initialStatus(actor);
    const [updated] = await tx
      .update(productImages)
      .set({
        storedImageId: img.id,
        url: imageUrl(img.id),
        moderationStatus,
        rejectionReason: null,
        moderatedBy: moderationStatus === "APPROVED" ? row.moderatedBy : null,
        moderatedAt: moderationStatus === "APPROVED" ? row.moderatedAt : null,
      })
      .where(eq(productImages.id, imageId))
      .returning();
    await dropIfOrphaned(tx, row.storedImageId);
    await syncPrimary(tx, productId, row.shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product_image",
        entityId: imageId,
        previousValue: { url: row.url },
        newValue: { change: "replaced", url: updated.url },
      },
      tx,
    );
    return updated;
  });
}

export async function updateAltText(productId: string, imageId: string, altText: string | null, actor: Actor): Promise<void> {
  const [probe] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db.update(productImages).set({ altText: altText?.trim() || null }).where(eq(productImages.id, imageId));
}

/** Deletes a photo. If it was primary, the next photo in order takes over (or the mirror is cleared). */
export async function deleteImage(productId: string, imageId: string, actor: Actor): Promise<void> {
  const [probe] = await db.select().from(productImages).where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    await tx.delete(productImages).where(eq(productImages.id, imageId));
    if (row.isPrimary) {
      const [next] = await listImages(productId, row.shopProductId, tx);
      if (next) await tx.update(productImages).set({ isPrimary: true }).where(eq(productImages.id, next.id));
    }
    await dropIfOrphaned(tx, row.storedImageId);
    await syncPrimary(tx, productId, row.shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product_image",
        entityId: imageId,
        previousValue: { url: row.url, primary: row.isPrimary },
        newValue: { change: "deleted" },
      },
      tx,
    );
  });
}

/* ------------------------------------------------- shop photo catalogue */

/** One tile of a shop's photo catalogue: a listing, the photo customers see, and its prices. */
export interface ShopCatalogueTile {
  shopProductId: string;
  productId: string;
  productName: string;
  categoryName: string;
  unit: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  isAvailable: boolean;
  trackInventory: boolean;
  onlineStock: number;
  /** The shop no longer carries the product's category, so customers do not see it. */
  paused: boolean;
  /** The photo customers see — the same one the storefront shows; null when there is none. */
  liveImageUrl: string | null;
  /** LISTING: this shop's own photo. PRODUCT: the catalogue photo every shop shares. */
  liveImageSource: "LISTING" | "PRODUCT" | null;
  /** The listing's own primary photo in any review state — what "Change photo" replaces. */
  ownPrimary: Pick<ProductImage, "id" | "url" | "moderationStatus" | "rejectionReason"> | null;
  ownPhotoCount: number;
  pendingCount: number;
}

/**
 * Every listing of a shop with its photo and prices, for the owner's photo
 * catalogue. Two queries whatever the size of the shop: the listings, then
 * all of their own photos. The live photo is read from the image_url mirrors
 * exactly as the storefront reads it, so the tile and the shop page agree.
 */
export async function listShopPhotoCatalogue(shopId: string): Promise<ShopCatalogueTile[]> {
  const listings = await listShopProducts(shopId);
  if (listings.length === 0) return [];

  const own = await db
    .select()
    .from(productImages)
    .where(inArray(productImages.shopProductId, listings.map((l) => l.id)))
    .orderBy(sql`${productImages.isPrimary} DESC`, asc(productImages.sortOrder), asc(productImages.createdAt));
  const byListing = new Map<string, ProductImage[]>();
  for (const image of own) {
    const key = image.shopProductId as string;
    const group = byListing.get(key);
    if (group) group.push(image);
    else byListing.set(key, [image]);
  }

  return listings.map((l) => {
    const images = byListing.get(l.id) ?? [];
    const primary = images[0];
    return {
      shopProductId: l.id,
      productId: l.productId,
      productName: l.product.name,
      categoryName: l.category.name,
      unit: l.product.unit,
      onlinePricePaise: l.onlinePricePaise,
      offlinePricePaise: l.offlinePricePaise,
      onlineSaleEnabled: l.onlineSaleEnabled,
      offlineSaleEnabled: l.offlineSaleEnabled,
      isAvailable: l.isAvailable,
      trackInventory: l.trackInventory,
      onlineStock: l.onlineStock,
      paused: l.categoryCarried === false,
      liveImageUrl: l.imageUrl ?? l.product.imageUrl,
      liveImageSource: l.imageUrl ? "LISTING" : l.product.imageUrl ? "PRODUCT" : null,
      ownPrimary: primary
        ? {
            id: primary.id,
            url: primary.url,
            moderationStatus: primary.moderationStatus,
            rejectionReason: primary.rejectionReason,
          }
        : null,
      ownPhotoCount: images.length,
      pendingCount: images.filter((i) => i.moderationStatus === "PENDING").length,
    };
  });
}

/* ------------------------------------------------------- moderation (F10) */

/** Photos waiting for review, oldest first, with where they would appear. */
export async function listPendingImages(limit = 100) {
  return db
    .select({
      id: productImages.id,
      url: productImages.url,
      altText: productImages.altText,
      productId: productImages.productId,
      productName: products.name,
      shopProductId: productImages.shopProductId,
      shopName: shops.name,
      createdBy: productImages.createdBy,
      createdAt: productImages.createdAt,
    })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .leftJoin(shopProducts, eq(shopProducts.id, productImages.shopProductId))
    .leftJoin(shops, eq(shops.id, shopProducts.shopId))
    .where(eq(productImages.moderationStatus, "PENDING"))
    .orderBy(asc(productImages.createdAt))
    .limit(limit);
}

/** Approve (goes live) or reject (with a reason the uploader sees). Staff only. */
export async function moderateImage(
  imageId: string,
  input: { decision: "approve" | "reject"; reason?: string | null },
  actor: Actor,
): Promise<ProductImage> {
  if (!isStaff(actor.role)) throw forbidden("Only GoKesari staff can review photos.");
  const reason = input.reason?.trim() || null;
  if (input.decision === "reject" && (!reason || reason.length < 3)) {
    throw validationFailed("Give the shop a reason for rejecting the photo.");
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(productImages).where(eq(productImages.id, imageId)).for("update");
    if (!row) throw notFound("Photo");
    if (row.moderationStatus !== "PENDING") throw conflict("This photo has already been reviewed.");
    const [next] = await tx
      .update(productImages)
      .set({
        moderationStatus: input.decision === "approve" ? "APPROVED" : "REJECTED",
        rejectionReason: input.decision === "reject" ? reason : null,
        moderatedBy: actor.id,
        moderatedAt: new Date(),
      })
      .where(eq(productImages.id, imageId))
      .returning();
    await syncPrimary(tx, row.productId, row.shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_MODERATED,
        entityType: "product_image",
        entityId: imageId,
        newValue: { decision: input.decision, reason },
      },
      tx,
    );
    return next;
  });
  if (updated.createdBy) {
    const [product] = await db.select({ name: products.name }).from(products).where(eq(products.id, updated.productId));
    await notify({
      userId: updated.createdBy,
      type: NOTIFICATION_TYPES.SHOP_PRODUCT_IMAGE_DECIDED,
      title: input.decision === "approve" ? "Photo approved" : "Photo not approved",
      body:
        input.decision === "approve"
          ? `Your photo for ${product?.name ?? "a product"} is now live.`
          : `Your photo for ${product?.name ?? "a product"} was not approved: ${reason}`,
      actionUrl: updated.shopProductId ? `/shop/products/${updated.shopProductId}/images` : "/shop/products",
    }).catch((error) => console.error("[image-moderation] notify failed", error));
  }
  return updated;
}

/**
 * True when a stored file is used only by photos not (yet) approved — the
 * file is then served to its uploader and staff only (F10). Files used by an
 * approved photo, or by no photo at all, are unaffected.
 */
export async function isHiddenProductFile(storedImageId: string): Promise<boolean> {
  const refs = await db
    .select({ status: productImages.moderationStatus })
    .from(productImages)
    .where(eq(productImages.storedImageId, storedImageId));
  return refs.length > 0 && refs.every((r) => r.status !== "APPROVED");
}

export { isStaff as isImageStaff };
