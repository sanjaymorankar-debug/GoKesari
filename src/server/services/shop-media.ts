/**
 * Shop product photos and descriptions (Module 1, docs/three-modules-2026-10).
 *
 * Per product in a shop (a shop_products row, "listing"): up to N photos
 * (rule shopProductMedia.maxPhotos, 5), a short description and a long one.
 * They override the master product's photos and description for that shop
 * only; whatever the shop has not set falls back to the master's.
 *
 * Photos are product_images rows scoped to the listing (the same table and
 * moderation flow as before), each pointing at a stored_images row made by the
 * photo pipeline (server/media/photo-pipeline.ts): EXIF stripped, three WebP
 * sizes, stored under MEDIA_DIR or in the database. The first photo in order
 * is the main photo, mirrored to shop_products.image_url so every existing
 * reader (shop page, cart, orders) shows it.
 *
 * Every change is audited against the listing (entity "shop_product") with
 * who acted, as what (owner, staff, support), and the before/after values.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { auditLogs, productImages, products, shopProducts, users, type ProductImage } from "@/server/db/schema";
import { processProductPhoto } from "@/server/media/photo-pipeline";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import {
  discardPhotoBlobs,
  imageUrl,
  insertProcessedPhoto,
  storePhotoBlobs,
} from "./image-store";
import { dropIfOrphaned, galleryFor, initialStatus, listImages, syncPrimary } from "./product-images";
import { getRule } from "./settings";
import { loadShopListing, type CatalogueActor } from "./shop-staff";

/* ------------------------------------------------------------ descriptions */

/** Collapses runs of spaces, keeps line breaks, drops control characters. */
function cleanText(value: string, multiline: boolean): string {
  // eslint-disable-next-line no-control-regex
  let text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  text = multiline ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : text.replace(/\s+/g, " ");
  return text.trim();
}

/** The first `max` characters of a text, cut at a word boundary, with an ellipsis when cut. */
export function summarise(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface EffectiveDescriptions {
  shortDescription: string | null;
  longDescription: string | null;
  /** Where each came from: the shop's own text or the master product's. */
  shortSource: "SHOP" | "MASTER" | null;
  longSource: "SHOP" | "MASTER" | null;
}

/**
 * What customers see: the shop's own short/long description, else the master
 * product's description (summarised for the short one).
 */
export function effectiveDescriptions(
  listing: { shortDescription: string | null; longDescription: string | null },
  masterDescription: string | null,
  shortMax = 160,
): EffectiveDescriptions {
  const master = masterDescription?.trim() || null;
  const short = listing.shortDescription ?? (master ? summarise(master, shortMax) : null);
  const long = listing.longDescription ?? master;
  return {
    shortDescription: short,
    longDescription: long,
    shortSource: listing.shortDescription ? "SHOP" : short ? "MASTER" : null,
    longSource: listing.longDescription ? "SHOP" : long ? "MASTER" : null,
  };
}

/* ------------------------------------------------------------------- view */

export interface ListingMediaView {
  listing: {
    id: string;
    shopId: string;
    productId: string;
    productName: string;
    productCode: string;
    gtin: string | null;
    barcode: string | null;
    shortDescription: string | null;
    longDescription: string | null;
    contentUpdatedAt: Date | null;
  };
  /** The shop's own photos in every review state, main photo first. */
  photos: Pick<ProductImage, "id" | "url" | "isPrimary" | "sortOrder" | "moderationStatus" | "rejectionReason" | "createdAt">[];
  /** The master product's approved photos (what customers see while the shop has none). */
  masterPhotos: Pick<ProductImage, "id" | "url">[];
  masterDescription: string | null;
  /** What customers see right now. */
  effective: EffectiveDescriptions & { photos: { id: string; url: string; source: "SHOP" | "MASTER" }[] };
  limits: { maxPhotos: number; maxUploadBytes: number; shortDescriptionMax: number; longDescriptionMax: number };
}

const photoView = (p: ProductImage) => ({
  id: p.id,
  url: p.url,
  isPrimary: p.isPrimary,
  sortOrder: p.sortOrder,
  moderationStatus: p.moderationStatus,
  rejectionReason: p.rejectionReason,
  createdAt: p.createdAt,
});

export async function getListingMedia(shopId: string, listingId: string): Promise<ListingMediaView> {
  const listing = await loadShopListing(shopId, listingId);
  const [product] = await db.select().from(products).where(eq(products.id, listing.productId));
  if (!product) throw notFound("Product");
  const rules = await getRule("shopProductMedia");
  const own = await listImages(listing.productId, listing.id);
  const master = await listImages(listing.productId, null, db, { approvedOnly: true });
  const live = await galleryFor(listing.productId, listing.id);
  return {
    listing: {
      id: listing.id,
      shopId: listing.shopId,
      productId: listing.productId,
      productName: product.name,
      productCode: product.code,
      gtin: product.gtin,
      barcode: product.barcode,
      shortDescription: listing.shortDescription,
      longDescription: listing.longDescription,
      contentUpdatedAt: listing.contentUpdatedAt,
    },
    photos: own.map(photoView),
    masterPhotos: master.map((p) => ({ id: p.id, url: p.url })),
    masterDescription: product.description,
    effective: {
      ...effectiveDescriptions(listing, product.description, rules.shortDescriptionMax),
      photos: live.map((p) => ({ id: p.id, url: p.url, source: p.shopProductId ? "SHOP" : "MASTER" })),
    },
    limits: {
      maxPhotos: rules.maxPhotos,
      maxUploadBytes: rules.maxUploadBytes,
      shortDescriptionMax: rules.shortDescriptionMax,
      longDescriptionMax: rules.longDescriptionMax,
    },
  };
}

/* ---------------------------------------------------------------- helpers */

/** Locks the listing so concurrent edits of the same product serialise (the 5-photo cap holds). */
async function lockListing(tx: DbClient, listingId: string) {
  const [row] = await tx.select().from(shopProducts).where(eq(shopProducts.id, listingId)).for("update");
  if (!row) throw notFound("Product in this shop");
  return row;
}

async function touchContent(tx: DbClient, listingId: string, actorId: string) {
  await tx
    .update(shopProducts)
    .set({ contentUpdatedAt: new Date(), contentUpdatedBy: actorId, updatedAt: new Date() })
    .where(eq(shopProducts.id, listingId));
}

async function auditMedia(
  tx: DbClient,
  actor: CatalogueActor,
  listingId: string,
  newValue: Record<string, unknown>,
  previousValue?: Record<string, unknown>,
) {
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_PRODUCT_MEDIA_CHANGED,
      entityType: "shop_product",
      entityId: listingId,
      previousValue,
      newValue: { ...newValue, via: actor.via },
    },
    tx,
  );
}

/** Sets the order of the listing's own photos; the first becomes the main photo. Inside a transaction. */
async function applyOrder(tx: DbClient, productId: string, listingId: string, orderedIds: string[]) {
  await tx
    .update(productImages)
    .set({ isPrimary: false })
    .where(and(eq(productImages.shopProductId, listingId), eq(productImages.isPrimary, true)));
  for (const [index, id] of orderedIds.entries()) {
    await tx
      .update(productImages)
      .set({ sortOrder: index, isPrimary: index === 0 })
      .where(and(eq(productImages.id, id), eq(productImages.shopProductId, listingId)));
  }
  await syncPrimary(tx, productId, listingId);
}

/* ----------------------------------------------------------------- photos */

export interface AddedPhoto {
  id: string;
  url: string;
  isPrimary: boolean;
  moderationStatus: ProductImage["moderationStatus"];
}

/**
 * Inserts an already-processed, already-stored photo as the listing's last
 * photo (first = main). The caller holds the listing lock.
 */
async function attachPhoto(
  tx: DbClient,
  listing: { id: string; productId: string },
  photo: Awaited<ReturnType<typeof processProductPhoto>>,
  blobs: Awaited<ReturnType<typeof storePhotoBlobs>>,
  actor: CatalogueActor,
  moderationStatus: ProductImage["moderationStatus"],
  maxPhotos: number,
  extra: Record<string, unknown> = {},
): Promise<AddedPhoto> {
  const existing = await listImages(listing.productId, listing.id, tx);
  if (existing.length >= maxPhotos) {
    throw validationFailed(`A product can have at most ${maxPhotos} photos in your shop. Remove one first.`, {
      reason: "PHOTO_LIMIT",
      maxPhotos,
    });
  }
  const stored = await insertProcessedPhoto(photo, blobs, actor.id, tx);
  const [row] = await tx
    .insert(productImages)
    .values({
      productId: listing.productId,
      shopProductId: listing.id,
      storedImageId: stored.id,
      url: imageUrl(stored.id),
      isPrimary: existing.length === 0,
      sortOrder: existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1,
      createdBy: actor.id,
      moderationStatus,
    })
    .returning();
  await syncPrimary(tx, listing.productId, listing.id);
  await touchContent(tx, listing.id, actor.id);
  await auditMedia(tx, actor, listing.id, {
    change: "photo_added",
    imageId: row.id,
    storedImageId: stored.id,
    position: existing.length + 1,
    moderationStatus,
    source: { type: photo.source.contentType, bytes: photo.source.bytes, width: photo.source.width, height: photo.source.height },
    ...extra,
  });
  return { id: row.id, url: row.url, isPrimary: row.isPrimary, moderationStatus: row.moderationStatus };
}

/** Processes, stores and adds one photo to a listing. */
export async function uploadListingPhoto(
  shopId: string,
  listingId: string,
  bytes: Buffer,
  actor: CatalogueActor,
  extra: Record<string, unknown> = {},
): Promise<AddedPhoto> {
  const listing = await loadShopListing(shopId, listingId);
  const rules = await getRule("shopProductMedia");
  // Cheap refusal before any image work; re-checked under the lock below.
  const before = await listImages(listing.productId, listing.id);
  if (before.length >= rules.maxPhotos) {
    throw validationFailed(`A product can have at most ${rules.maxPhotos} photos in your shop. Remove one first.`, {
      reason: "PHOTO_LIMIT",
      maxPhotos: rules.maxPhotos,
    });
  }
  const photo = await processProductPhoto(bytes, rules);
  const blobs = await storePhotoBlobs(photo);
  const moderationStatus = await initialStatus(actor);
  try {
    return await db.transaction(async (tx) => {
      await lockListing(tx, listing.id);
      return attachPhoto(tx, listing, photo, blobs, actor, moderationStatus, rules.maxPhotos, extra);
    });
  } catch (error) {
    await discardPhotoBlobs(blobs);
    throw error;
  }
}

/** Reorders the listing's own photos; `orderedIds` must list each exactly once. The first is the main photo. */
export async function reorderListingPhotos(
  shopId: string,
  listingId: string,
  orderedIds: string[],
  actor: CatalogueActor,
): Promise<void> {
  const listing = await loadShopListing(shopId, listingId);
  await db.transaction(async (tx) => {
    await lockListing(tx, listing.id);
    const current = await listImages(listing.productId, listing.id, tx);
    const same =
      current.length === orderedIds.length &&
      new Set(orderedIds).size === orderedIds.length &&
      current.every((c) => orderedIds.includes(c.id));
    if (!same) throw validationFailed("The new order must list each of this product's photos exactly once.");
    const previous = current.map((c) => c.id);
    if (previous.every((id, i) => id === orderedIds[i])) return;
    await applyOrder(tx, listing.productId, listing.id, orderedIds);
    await touchContent(tx, listing.id, actor.id);
    await auditMedia(tx, actor, listing.id, { change: "photos_reordered", order: orderedIds }, { order: previous });
  });
}

/** Removes one of the listing's own photos; the next one becomes the main photo if it was. */
export async function deleteListingPhoto(
  shopId: string,
  listingId: string,
  imageId: string,
  actor: CatalogueActor,
): Promise<void> {
  const listing = await loadShopListing(shopId, listingId);
  await db.transaction(async (tx) => {
    await lockListing(tx, listing.id);
    const [row] = await tx
      .select()
      .from(productImages)
      .where(and(eq(productImages.id, imageId), eq(productImages.shopProductId, listing.id)));
    if (!row) throw notFound("Photo");
    await tx.delete(productImages).where(eq(productImages.id, imageId));
    const remaining = await listImages(listing.productId, listing.id, tx);
    if (row.isPrimary && remaining.length > 0) {
      await applyOrder(tx, listing.productId, listing.id, remaining.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.id));
    }
    await dropIfOrphaned(tx, row.storedImageId);
    await syncPrimary(tx, listing.productId, listing.id);
    await touchContent(tx, listing.id, actor.id);
    await auditMedia(tx, actor, listing.id, { change: "photo_removed", imageId }, { url: row.url, wasMain: row.isPrimary });
  });
}

/* ----------------------------------------------------------- descriptions */

export interface DescriptionInput {
  /** undefined = leave as is; null or "" = clear (show the master's). */
  shortDescription?: string | null;
  longDescription?: string | null;
}

/** Validates and normalises a description patch against the rule limits. */
export function normaliseDescriptions(
  input: DescriptionInput,
  limits: { shortDescriptionMax: number; longDescriptionMax: number },
): { shortDescription?: string | null; longDescription?: string | null } {
  const out: { shortDescription?: string | null; longDescription?: string | null } = {};
  if (input.shortDescription !== undefined) {
    const text = input.shortDescription === null ? "" : cleanText(input.shortDescription, false);
    if (text.length > limits.shortDescriptionMax) {
      throw validationFailed(`The short description can be at most ${limits.shortDescriptionMax} characters.`, {
        fields: { shortDescription: `At most ${limits.shortDescriptionMax} characters.` },
      });
    }
    out.shortDescription = text || null;
  }
  if (input.longDescription !== undefined) {
    const text = input.longDescription === null ? "" : cleanText(input.longDescription, true);
    if (text.length > limits.longDescriptionMax) {
      throw validationFailed(`The long description can be at most ${limits.longDescriptionMax} characters.`, {
        fields: { longDescription: `At most ${limits.longDescriptionMax} characters.` },
      });
    }
    out.longDescription = text || null;
  }
  return out;
}

/** Sets the listing's own descriptions inside a transaction (the caller holds the lock). Returns whether anything changed. */
export async function writeDescriptions(
  tx: DbClient,
  listing: { id: string; shortDescription: string | null; longDescription: string | null },
  patch: { shortDescription?: string | null; longDescription?: string | null },
  actor: CatalogueActor,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const changes: Record<string, string | null> = {};
  const previous: Record<string, string | null> = {};
  if (patch.shortDescription !== undefined && patch.shortDescription !== listing.shortDescription) {
    changes.shortDescription = patch.shortDescription;
    previous.shortDescription = listing.shortDescription;
  }
  if (patch.longDescription !== undefined && patch.longDescription !== listing.longDescription) {
    changes.longDescription = patch.longDescription;
    previous.longDescription = listing.longDescription;
  }
  if (Object.keys(changes).length === 0) return false;
  await tx
    .update(shopProducts)
    .set({ ...changes, contentUpdatedAt: new Date(), contentUpdatedBy: actor.id, updatedAt: new Date() })
    .where(eq(shopProducts.id, listing.id));
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_PRODUCT_DESCRIPTION_CHANGED,
      entityType: "shop_product",
      entityId: listing.id,
      previousValue: previous,
      newValue: { ...changes, via: actor.via, ...extra },
    },
    tx,
  );
  return true;
}

export async function updateListingDescriptions(
  shopId: string,
  listingId: string,
  input: DescriptionInput,
  actor: CatalogueActor,
): Promise<{ shortDescription: string | null; longDescription: string | null }> {
  const listing = await loadShopListing(shopId, listingId);
  const rules = await getRule("shopProductMedia");
  const patch = normaliseDescriptions(input, rules);
  return db.transaction(async (tx) => {
    const locked = await lockListing(tx, listing.id);
    await writeDescriptions(tx, locked, patch, actor);
    const [after] = await tx
      .select({ shortDescription: shopProducts.shortDescription, longDescription: shopProducts.longDescription })
      .from(shopProducts)
      .where(eq(shopProducts.id, listing.id));
    return after;
  });
}

/* ---------------------------------------------------------------- history */

export interface ListingChange {
  id: string;
  at: Date;
  action: string;
  actorName: string | null;
  via: string | null;
  summary: string;
  previousValue: unknown;
  newValue: unknown;
}

const SUMMARIES: Record<string, string> = {
  photo_added: "Added a photo",
  photo_removed: "Removed a photo",
  photos_reordered: "Changed the photo order",
};

/** Who changed this listing's photos and descriptions, newest first. */
export async function listingHistory(shopId: string, listingId: string, limit = 100): Promise<ListingChange[]> {
  await loadShopListing(shopId, listingId);
  const rows = await db
    .select({
      id: auditLogs.id,
      at: auditLogs.createdAt,
      action: auditLogs.action,
      previousValue: auditLogs.previousValue,
      newValue: auditLogs.newValue,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(
      and(
        eq(auditLogs.entityType, "shop_product"),
        eq(auditLogs.entityId, listingId),
        inArray(auditLogs.action, [AUDIT_ACTIONS.SHOP_PRODUCT_MEDIA_CHANGED, AUDIT_ACTIONS.SHOP_PRODUCT_DESCRIPTION_CHANGED]),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const next = (r.newValue ?? {}) as Record<string, unknown>;
    let summary = "Changed";
    if (r.action === AUDIT_ACTIONS.SHOP_PRODUCT_DESCRIPTION_CHANGED) {
      const parts = ["shortDescription" in next ? "short" : null, "longDescription" in next ? "long" : null].filter(Boolean);
      summary = `Changed the ${parts.join(" and ")} description`;
    } else if (typeof next.change === "string") {
      summary = SUMMARIES[next.change] ?? "Changed the photos";
    }
    if (next.importId) summary += " (bulk upload)";
    return {
      id: r.id,
      at: r.at,
      action: r.action,
      actorName: r.actorName ?? r.actorEmail ?? null,
      via: typeof next.via === "string" ? next.via : null,
      summary,
      previousValue: r.previousValue,
      newValue: r.newValue,
    };
  });
}

/* ---------------------------------------------------- storefront helpers */

/** Shop-specific descriptions for many listings at once (storefront cards). */
export async function shortDescriptionsFor(listingIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (listingIds.length === 0) return out;
  const rules = await getRule("shopProductMedia");
  const rows = await db
    .select({
      id: shopProducts.id,
      shortDescription: shopProducts.shortDescription,
      longDescription: shopProducts.longDescription,
      master: products.description,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(inArray(shopProducts.id, listingIds));
  for (const r of rows) out.set(r.id, effectiveDescriptions(r, r.master, rules.shortDescriptionMax).shortDescription);
  return out;
}

/** The listing of a product in a shop, if the shop carries it (product page from a shop). */
export async function findListing(shopId: string, productId: string) {
  const [row] = await db
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.shopId, shopId), eq(shopProducts.productId, productId), isNull(shopProducts.deletedAt)));
  return row ?? null;
}

/** Listings of a shop with their own photo count and description state, for the owner/staff list. */
export async function listingsContentSummary(shopId: string) {
  return db
    .select({
      id: shopProducts.id,
      productId: shopProducts.productId,
      productName: products.name,
      productCode: products.code,
      imageUrl: sql<string | null>`coalesce(${shopProducts.imageUrl}, ${products.imageUrl})`,
      ownPhotos: sql<number>`(select count(*)::int from ${productImages} pi where pi.shop_product_id = ${shopProducts.id})`,
      hasShortDescription: sql<boolean>`${shopProducts.shortDescription} is not null`,
      hasLongDescription: sql<boolean>`${shopProducts.longDescription} is not null`,
      contentUpdatedAt: shopProducts.contentUpdatedAt,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)))
    .orderBy(asc(products.name));
}

export { attachPhoto as attachProcessedPhoto, lockListing, applyOrder };
