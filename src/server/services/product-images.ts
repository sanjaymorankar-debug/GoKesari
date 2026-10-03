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
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";

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
import { imageUrl } from "./image-store";
import { getRule } from "./settings";
import { insertReturning, updateReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

const isStaff = (role: UserRole) => role === "OPERATOR" || role === "ADMIN";

const scopeWhere = (productId: string, shopProductId: string | null) =>
  shopProductId
    ? and(
        eq(productImages.productId, productId),
        eq(productImages.shopProductId, shopProductId),
      )
    : and(
        eq(productImages.productId, productId),
        isNull(productImages.shopProductId),
      );

/** Photos in one scope, primary first then by order. */
export async function listImages(
  productId: string,
  shopProductId: string | null = null,
  client: DbClient = db,
): Promise<ProductImage[]> {
  return client
    .select()
    .from(productImages)
    .where(scopeWhere(productId, shopProductId))
    .orderBy(
      sql`${productImages.isPrimary} DESC`,
      asc(productImages.sortOrder),
      asc(productImages.createdAt),
    );
}

/** What a page shows: the listing's own photos if it has any, else the product's. */
export async function galleryFor(
  productId: string,
  shopProductId?: string | null,
): Promise<ProductImage[]> {
  if (shopProductId) {
    const own = await listImages(productId, shopProductId);
    if (own.length > 0) return own;
  }
  return listImages(productId, null);
}

async function assertMayManage(
  actor: Actor,
  productId: string,
  shopProductId: string | null,
): Promise<void> {
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId));
  if (!product) throw notFound("Product");
  if (shopProductId) {
    const [row] = await db
      .select({ productId: shopProducts.productId, ownerId: shops.ownerId })
      .from(shopProducts)
      .innerJoin(shops, eq(shopProducts.shopId, shops.id))
      .where(eq(shopProducts.id, shopProductId));
    if (!row || row.productId !== productId) throw notFound("Listing");
    if (row.ownerId !== actor.id && !isStaff(actor.role))
      throw forbidden("This listing does not belong to you.");
    return;
  }
  if (!isStaff(actor.role) && product.createdBy !== actor.id) {
    throw forbidden(
      "Only catalogue staff, or the shop that created this product, can change its photos.",
    );
  }
}

/** Keeps products.image_url / shop_products.image_url equal to the primary photo. */
async function syncPrimary(
  tx: DbClient,
  productId: string,
  shopProductId: string | null,
): Promise<void> {
  const [primary] = await tx
    .select({ url: productImages.url })
    .from(productImages)
    .where(
      and(
        scopeWhere(productId, shopProductId),
        eq(productImages.isPrimary, true),
      ),
    );
  if (shopProductId) {
    await tx
      .update(shopProducts)
      .set({ imageUrl: primary?.url ?? null, updatedAt: new Date() })
      .where(eq(shopProducts.id, shopProductId));
  } else {
    await tx
      .update(products)
      .set({ imageUrl: primary?.url ?? null })
      .where(eq(products.id, productId));
  }
}

/** Deletes an uploaded file once no photo row points at it. */
async function dropIfOrphaned(
  tx: DbClient,
  storedImageId: string | null,
): Promise<void> {
  if (!storedImageId) return;
  const [ref] = await tx
    .select({ id: productImages.id })
    .from(productImages)
    .where(eq(productImages.storedImageId, storedImageId))
    .limit(1);
  if (!ref)
    await tx.delete(storedImages).where(eq(storedImages.id, storedImageId));
}

async function loadUploaded(tx: DbClient, storedImageId: string, actor: Actor) {
  const [img] = await tx
    .select()
    .from(storedImages)
    .where(eq(storedImages.id, storedImageId));
  if (!img || img.purpose !== "PRODUCT")
    throw validationFailed("That upload cannot be used as a product photo.");
  if (img.ownerId !== actor.id && !isStaff(actor.role))
    throw forbidden("That upload is not yours.");
  return img;
}

export async function addImage(
  input: {
    productId: string;
    shopProductId?: string | null;
    storedImageId: string;
    altText?: string | null;
  },
  actor: Actor,
): Promise<ProductImage> {
  const shopProductId = input.shopProductId ?? null;
  await assertMayManage(actor, input.productId, shopProductId);
  const limits = await getRule("images");

  return db.transaction(async (tx) => {
    const img = await loadUploaded(tx, input.storedImageId, actor);
    const existing = await listImages(input.productId, shopProductId, tx);
    if (existing.length >= limits.maxPerProduct) {
      throw validationFailed(
        `At most ${limits.maxPerProduct} photos can be kept here. Delete one first.`,
      );
    }
    if (existing.some((e) => e.storedImageId === img.id))
      throw conflict("That photo is already added.");

    const [row] = await insertReturning(tx, productImages, {
      productId: input.productId,
      shopProductId,
      storedImageId: img.id,
      url: imageUrl(img.id),
      altText: input.altText?.trim() || null,
      // The first photo of a scope is its primary.
      isPrimary: existing.length === 0,
      sortOrder:
        existing.length === 0
          ? 0
          : Math.max(...existing.map((e) => e.sortOrder)) + 1,
      createdBy: actor.id,
    });
    await syncPrimary(tx, input.productId, shopProductId);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_CHANGED,
        entityType: "product_image",
        entityId: row.id,
        newValue: {
          change: "added",
          productId: input.productId,
          shopProductId,
          primary: row.isPrimary,
        },
      },
      tx,
    );
    return row;
  });
}

async function loadImage(
  tx: DbClient,
  imageId: string,
  productId: string,
): Promise<ProductImage> {
  const [row] = await tx
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));
  if (!row || row.productId !== productId) throw notFound("Photo");
  return row;
}

export async function setPrimaryImage(
  productId: string,
  imageId: string,
  actor: Actor,
): Promise<void> {
  const [probe] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    if (row.isPrimary) return;
    // Demote first so the one-primary-per-scope index is never violated.
    await tx
      .update(productImages)
      .set({ isPrimary: false })
      .where(
        and(
          scopeWhere(productId, row.shopProductId),
          eq(productImages.isPrimary, true),
        ),
      );
    await tx
      .update(productImages)
      .set({ isPrimary: true })
      .where(eq(productImages.id, imageId));
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
    if (!same)
      throw validationFailed(
        "The new order must list each photo exactly once.",
      );
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(productImages)
        .set({ sortOrder: index })
        .where(eq(productImages.id, id));
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
  const [probe] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  return db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    const img = await loadUploaded(tx, storedImageId, actor);
    const [updated] = await updateReturning(
      tx,
      productImages,
      { storedImageId: img.id, url: imageUrl(img.id) },
      eq(productImages.id, imageId),
    );
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

export async function updateAltText(
  productId: string,
  imageId: string,
  altText: string | null,
  actor: Actor,
): Promise<void> {
  const [probe] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db
    .update(productImages)
    .set({ altText: altText?.trim() || null })
    .where(eq(productImages.id, imageId));
}

/** Deletes a photo. If it was primary, the next photo in order takes over (or the mirror is cleared). */
export async function deleteImage(
  productId: string,
  imageId: string,
  actor: Actor,
): Promise<void> {
  const [probe] = await db
    .select()
    .from(productImages)
    .where(eq(productImages.id, imageId));
  if (!probe || probe.productId !== productId) throw notFound("Photo");
  await assertMayManage(actor, productId, probe.shopProductId);
  await db.transaction(async (tx) => {
    const row = await loadImage(tx, imageId, productId);
    await tx.delete(productImages).where(eq(productImages.id, imageId));
    if (row.isPrimary) {
      const [next] = await listImages(productId, row.shopProductId, tx);
      if (next)
        await tx
          .update(productImages)
          .set({ isPrimary: true })
          .where(eq(productImages.id, next.id));
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
