/**
 * Bulk shop product photos and descriptions (Module 1, docs/three-modules-2026-10).
 *
 * The owner (or staff) uploads a ZIP of photos named by SKU or barcode and/or
 * a CSV of descriptions. Two phases, like the Excel upload:
 *
 *   1. check — every ZIP entry and CSV row is matched to one of THIS shop's
 *      products and checked (type from the bytes, size, count per product);
 *      nothing live changes. The owner sees matched / not matched / invalid.
 *   2. apply — the matched photos are processed exactly like single uploads
 *      (EXIF stripped, three WebP sizes) and the descriptions written, one
 *      product per transaction. It runs straight after the "Apply" request
 *      returns (not on a schedule); the page shows its progress. An apply
 *      that stops half-way (the server restarted) can be resumed: finished
 *      products are skipped.
 *
 * File names: `<SKU or barcode>.jpg`, or `<SKU or barcode>_<n>.jpg` with n the
 * photo's position 1–5 (jpg, jpeg, png or webp). Matching tries the product
 * code (SKU, e.g. P00012), then the GTIN, then the barcode.
 *
 * CSV columns (header row, any order; extra columns ignored):
 *   sku_or_barcode (also: sku, code, barcode, gtin, ean), short_description,
 *   long_description (also: description). An empty cell leaves that text as it is.
 *
 * Photo mode: REPLACE (default) — a product's photos in the ZIP become its
 * photos, replacing the shop's earlier ones; ADD — appended, up to the limit.
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import JSZip from "jszip";

import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import type { RuleValue } from "@/server/config/rules";
import { db, type DbClient } from "@/server/db";
import {
  productImages,
  products,
  shopMediaImportItems,
  shopMediaImports,
  shopProducts,
  shops,
  type ShopMediaImport,
  type ShopMediaImportItem,
} from "@/server/db/schema";
import { putBlob, readBlob, scheduleOrphanSweep } from "@/server/media/blob-store";
import { precheckPhoto, processProductPhoto } from "@/server/media/photo-pipeline";
import { parseDelimited } from "@/server/pmd/sources/delimited";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { discardPhotoBlobs, storePhotoBlobs } from "./image-store";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { dropIfOrphaned, initialStatus, listImages } from "./product-images";
import { getRule } from "./settings";
import { attachProcessedPhoto, lockListing, normaliseDescriptions, writeDescriptions } from "./shop-media";
import type { CatalogueActor } from "./shop-staff";

export type PhotoMode = "REPLACE" | "ADD";

interface UploadFile {
  name: string;
  bytes: Buffer;
}

type MatchMethod = "SKU" | "GTIN" | "BARCODE";

interface ListingKey {
  listingId: string;
  productId: string;
  productName: string;
  ownPhotos: number;
}

/* ------------------------------------------------------------- matching */

const PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

/** Splits `P00012_2.jpg` into key `P00012` and position 2; `8901234567890.png` into the key alone. */
export function parsePhotoName(entryName: string): { key: string; position: number | null; ext: string } | null {
  const base = entryName.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const stem = base.slice(0, dot).trim();
  const m = /^(.+?)_(\d{1,2})$/.exec(stem);
  if (m) return { key: m[1].trim(), position: Number(m[2]), ext };
  return { key: stem, position: null, ext };
}

/** Lookup over one shop's live listings: code (case-insensitive), GTIN (digits), barcode. */
async function buildMatcher(shopId: string, client: DbClient = db) {
  const rows = await client
    .select({
      listingId: shopProducts.id,
      productId: products.id,
      productName: products.name,
      code: products.code,
      gtin: products.gtin,
      barcode: products.barcode,
      ownPhotos: sql<number>`(select count(*)::int from ${productImages} pi where pi.shop_product_id = ${shopProducts.id})`,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  const byCode = new Map<string, ListingKey>();
  const byGtin = new Map<string, ListingKey>();
  const byBarcode = new Map<string, ListingKey>();
  for (const r of rows) {
    const key: ListingKey = { listingId: r.listingId, productId: r.productId, productName: r.productName, ownPhotos: r.ownPhotos };
    byCode.set(r.code.toUpperCase(), key);
    if (r.gtin) byGtin.set(r.gtin, key);
    if (r.barcode) byBarcode.set(r.barcode.trim().toUpperCase(), key);
  }
  return (raw: string): { listing: ListingKey; method: MatchMethod } | null => {
    const key = raw.trim();
    if (!key) return null;
    const upper = key.toUpperCase();
    const code = byCode.get(upper);
    if (code) return { listing: code, method: "SKU" };
    const digits = key.replace(/[\s-]/g, "");
    if (/^\d+$/.test(digits)) {
      const gtin = byGtin.get(digits);
      if (gtin) return { listing: gtin, method: "GTIN" };
    }
    const barcode = byBarcode.get(upper) ?? byBarcode.get(digits.toUpperCase());
    if (barcode) return { listing: barcode, method: "BARCODE" };
    return null;
  };
}

/* ------------------------------------------------------------- ZIP reading */

/** Reads one ZIP entry, giving up past `max` bytes (so a crafted entry cannot fill memory). */
async function readEntryCapped(file: JSZip.JSZipObject, max: number): Promise<Buffer | null> {
  const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > max) return null;
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const stream = file.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > max) {
        done = true;
        (stream as unknown as { pause?: () => void }).pause?.();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    stream.on("error", (error: unknown) => {
      if (!done) reject(error);
    });
  });
}

function photoEntries(zip: JSZip): JSZip.JSZipObject[] {
  const entries: JSZip.JSZipObject[] = [];
  zip.forEach((path, file) => {
    if (file.dir) return;
    const parts = path.split("/");
    if (parts.some((p) => p === "__MACOSX" || p.startsWith("."))) return;
    entries.push(file);
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

async function openZip(bytes: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    throw validationFailed("The ZIP file could not be opened. Make it again and upload it.");
  }
}

/* ------------------------------------------------------------- CSV reading */

const KEY_COLUMNS = ["sku_or_barcode", "sku", "code", "product_code", "barcode", "gtin", "ean"];
const SHORT_COLUMNS = ["short_description", "short"];
const LONG_COLUMNS = ["long_description", "long", "description"];

const columnName = (h: string) => h.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");

async function readCsv(bytes: Buffer, maxRows: number): Promise<{ row: number; key: string; short?: string; long?: string }[]> {
  const rows: string[][] = [];
  try {
    async function* once() {
      yield bytes;
    }
    for await (const cells of parseDelimited(once(), { delimiter: ",", maxFieldLength: 50_000 })) {
      rows.push(cells);
      if (rows.length > maxRows + 1) throw validationFailed(`The CSV can have at most ${maxRows} rows.`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw validationFailed("The CSV file could not be read. Save it as CSV (comma separated) and upload it again.");
  }
  if (rows.length < 2) throw validationFailed("The CSV has no rows under its header.");
  const header = rows[0].map(columnName);
  const keyAt = header.findIndex((h) => KEY_COLUMNS.includes(h));
  const shortAt = header.findIndex((h) => SHORT_COLUMNS.includes(h));
  const longAt = header.findIndex((h) => LONG_COLUMNS.includes(h));
  if (keyAt < 0) throw validationFailed("The CSV needs a sku_or_barcode column.");
  if (shortAt < 0 && longAt < 0) throw validationFailed("The CSV needs a short_description or long_description column.");
  return rows.slice(1).map((cells, i) => ({
    row: i + 2,
    key: (cells[keyAt] ?? "").trim(),
    short: shortAt >= 0 ? cells[shortAt] : undefined,
    long: longAt >= 0 ? cells[longAt] : undefined,
  }));
}

/** The CSV template offered for download. */
export function mediaCsvTemplate(): string {
  return [
    "sku_or_barcode,short_description,long_description",
    'P00012,"Fresh toned milk, 500 ml pouch","Toned milk from our own dairy. Keep refrigerated; use within 2 days of opening."',
    "8901234567890,Crunchy salted peanuts,",
  ].join("\r\n");
}

/* ----------------------------------------------------------------- check */

type NewItem = typeof shopMediaImportItems.$inferInsert;

export async function createMediaImport(
  shopId: string,
  files: { zip?: UploadFile | null; csv?: UploadFile | null },
  photoMode: PhotoMode,
  actor: CatalogueActor,
): Promise<MediaImportView> {
  if (!files.zip && !files.csv) throw validationFailed("Choose a ZIP of photos, a CSV of descriptions, or both.");
  const rules = await getRule("shopProductMedia");
  const match = await buildMatcher(shopId);
  const items: NewItem[] = [];

  if (files.zip) {
    if (files.zip.bytes.length > rules.zipMaxBytes) {
      throw validationFailed(`The ZIP can be at most ${Math.round(rules.zipMaxBytes / (1024 * 1024))} MB.`);
    }
    const zip = await openZip(files.zip.bytes);
    const entries = photoEntries(zip);
    if (entries.length === 0) throw validationFailed("The ZIP has no files in it.");
    if (entries.length > rules.zipMaxFiles) {
      throw validationFailed(`The ZIP can hold at most ${rules.zipMaxFiles} photos; this one has ${entries.length}.`);
    }

    const perListing = new Map<string, { item: NewItem; position: number | null }[]>();
    const ownCounts = new Map<string, number>();
    for (const entry of entries) {
      const item: NewItem = { importId: "", kind: "PHOTO", sourceName: entry.name, status: "INVALID" };
      items.push(item);
      const parsed = parsePhotoName(entry.name);
      if (!parsed || !PHOTO_EXTENSIONS.has(parsed.ext)) {
        item.message = "Not a JPG, PNG or WebP file.";
        continue;
      }
      item.matchKey = parsed.key;
      if (parsed.position !== null && (parsed.position < 1 || parsed.position > rules.maxPhotos)) {
        item.message = `The number after _ must be 1 to ${rules.maxPhotos}.`;
        continue;
      }
      item.position = parsed.position;
      const found = match(parsed.key);
      if (!found) {
        item.status = "UNMATCHED";
        item.message = "No product in your shop has this SKU or barcode.";
        continue;
      }
      item.shopProductId = found.listing.listingId;
      item.matchMethod = found.method;
      ownCounts.set(found.listing.listingId, found.listing.ownPhotos);
      const bytes = await readEntryCapped(entry, rules.maxUploadBytes);
      if (!bytes) {
        item.message = `Larger than ${Math.round(rules.maxUploadBytes / (1024 * 1024))} MB.`;
        continue;
      }
      try {
        precheckPhoto(bytes, rules);
      } catch (error) {
        item.message = error instanceof Error ? error.message : "Not a usable photo.";
        continue;
      }
      item.status = "MATCHED";
      const group = perListing.get(found.listing.listingId) ?? [];
      group.push({ item, position: parsed.position });
      perListing.set(found.listing.listingId, group);
    }

    // Per product: explicit positions first (a repeated position is a duplicate), then the rest by name; cap at the limit.
    for (const [listingId, group] of perListing) {
      const seen = new Set<number>();
      const ordered: { item: NewItem; position: number | null }[] = [];
      for (const g of group.filter((x) => x.position !== null).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
        if (seen.has(g.position!)) {
          g.item.status = "DUPLICATE";
          g.item.message = `Another photo for this product is already number ${g.position}.`;
          continue;
        }
        seen.add(g.position!);
        ordered.push(g);
      }
      ordered.push(...group.filter((x) => x.position === null));
      const existing = photoMode === "ADD" ? (ownCounts.get(listingId) ?? 0) : 0;
      ordered.forEach((g, index) => {
        if (existing + index >= rules.maxPhotos) {
          g.item.status = "INVALID";
          g.item.message = `More than ${rules.maxPhotos} photos for this product.`;
        } else {
          g.item.position = index + 1;
        }
      });
    }
  }

  if (files.csv) {
    if (files.csv.bytes.length > 5 * 1024 * 1024) throw validationFailed("The CSV can be at most 5 MB.");
    const seenListings = new Set<string>();
    for (const row of await readCsv(files.csv.bytes, rules.csvMaxRows)) {
      const item: NewItem = { importId: "", kind: "DESCRIPTION", sourceName: `row ${row.row}`, status: "INVALID", matchKey: row.key || null };
      items.push(item);
      if (!row.key) {
        item.message = "No SKU or barcode in this row.";
        continue;
      }
      const found = match(row.key);
      if (!found) {
        item.status = "UNMATCHED";
        item.message = "No product in your shop has this SKU or barcode.";
        continue;
      }
      item.shopProductId = found.listing.listingId;
      item.matchMethod = found.method;
      if (seenListings.has(found.listing.listingId)) {
        item.status = "DUPLICATE";
        item.message = "This product already appears in an earlier row.";
        continue;
      }
      seenListings.add(found.listing.listingId);
      const patch: { shortDescription?: string; longDescription?: string } = {};
      if (row.short?.trim()) patch.shortDescription = row.short;
      if (row.long?.trim()) patch.longDescription = row.long;
      if (Object.keys(patch).length === 0) {
        item.status = "SKIPPED";
        item.message = "Both descriptions are empty; nothing to change.";
        continue;
      }
      try {
        item.payload = normaliseDescriptions(patch, rules) as Record<string, string | null>;
        item.status = "MATCHED";
      } catch (error) {
        item.message = error instanceof Error ? error.message : "Description not accepted.";
      }
    }
  }

  const archive = files.zip ? await putBlob(files.zip.bytes, "zip") : null;
  const totals = countItems(items);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(shopMediaImports)
      .values({
        shopId,
        uploadedBy: actor.id,
        status: "VALIDATED",
        photoMode,
        archiveName: files.zip?.name ?? null,
        archiveBytes: files.zip?.bytes.length ?? null,
        archiveStorage: archive?.storage ?? null,
        archiveKey: archive?.storageKey ?? null,
        archiveData: archive?.data ?? null,
        csvName: files.csv?.name ?? null,
        totals,
      })
      .returning({ id: shopMediaImports.id });
    for (let i = 0; i < items.length; i += 500) {
      await tx.insert(shopMediaImportItems).values(items.slice(i, i + 500).map((item) => ({ ...item, importId: created.id })));
    }
    return created;
  });
  return getMediaImport(shopId, row.id);
}

function countItems(items: Pick<NewItem, "kind" | "status">[]): Record<string, number> {
  const totals: Record<string, number> = { photos: 0, descriptions: 0 };
  for (const item of items) {
    totals[item.kind === "PHOTO" ? "photos" : "descriptions"] += 1;
    const key = (item.status ?? "INVALID").toLowerCase();
    totals[key] = (totals[key] ?? 0) + 1;
  }
  return totals;
}

/* ------------------------------------------------------------------ views */

/** An apply that has made no progress for this long is treated as stopped and may be resumed. */
const STALLED_AFTER_MS = 2 * 60_000;

export interface MediaImportView {
  import: Omit<ShopMediaImport, "archiveData" | "archiveKey" | "archiveStorage">;
  items: (ShopMediaImportItem & { productName: string | null; productCode: string | null })[];
  /** Products whose own photos REPLACE mode would remove, with how many. */
  replaces: { shopProductId: string; productName: string; photos: number }[];
  /** An apply that has made no progress for 2 minutes (the server restarted): it may be resumed. */
  stalled: boolean;
}

export async function getMediaImport(shopId: string, importId: string): Promise<MediaImportView> {
  const [row] = await db
    .select()
    .from(shopMediaImports)
    .where(and(eq(shopMediaImports.id, importId), eq(shopMediaImports.shopId, shopId)));
  if (!row) throw notFound("Upload");
  const items = await db
    .select({ item: shopMediaImportItems, productName: products.name, productCode: products.code })
    .from(shopMediaImportItems)
    .leftJoin(shopProducts, eq(shopProducts.id, shopMediaImportItems.shopProductId))
    .leftJoin(products, eq(products.id, shopProducts.productId))
    .where(eq(shopMediaImportItems.importId, importId))
    .orderBy(asc(shopMediaImportItems.kind), asc(shopMediaImportItems.sourceName));
  const photoListings = [
    ...new Set(items.filter((i) => i.item.kind === "PHOTO" && i.item.status === "MATCHED" && i.item.shopProductId).map((i) => i.item.shopProductId!)),
  ];
  let replaces: MediaImportView["replaces"] = [];
  if (row.photoMode === "REPLACE" && row.status === "VALIDATED" && photoListings.length > 0) {
    replaces = (
      await db
        .select({
          shopProductId: shopProducts.id,
          productName: products.name,
          photos: sql<number>`(select count(*)::int from ${productImages} pi where pi.shop_product_id = ${shopProducts.id})`,
        })
        .from(shopProducts)
        .innerJoin(products, eq(products.id, shopProducts.productId))
        .where(inArray(shopProducts.id, photoListings))
    ).filter((r) => r.photos > 0);
  }
  return {
    import: {
      id: row.id,
      shopId: row.shopId,
      uploadedBy: row.uploadedBy,
      status: row.status,
      photoMode: row.photoMode,
      archiveName: row.archiveName,
      archiveBytes: row.archiveBytes,
      csvName: row.csvName,
      totals: row.totals,
      lastProgressAt: row.lastProgressAt,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    items: items.map((i) => ({ ...i.item, productName: i.productName, productCode: i.productCode })),
    replaces,
    stalled:
      row.status === "APPLYING" && (!row.lastProgressAt || Date.now() - row.lastProgressAt.getTime() > STALLED_AFTER_MS),
  };
}

export async function listMediaImports(shopId: string, limit = 20) {
  return db
    .select({
      id: shopMediaImports.id,
      status: shopMediaImports.status,
      photoMode: shopMediaImports.photoMode,
      archiveName: shopMediaImports.archiveName,
      csvName: shopMediaImports.csvName,
      totals: shopMediaImports.totals,
      createdAt: shopMediaImports.createdAt,
      appliedAt: shopMediaImports.appliedAt,
    })
    .from(shopMediaImports)
    .where(eq(shopMediaImports.shopId, shopId))
    .orderBy(sql`${shopMediaImports.createdAt} DESC`)
    .limit(limit);
}

/* ------------------------------------------------------------------ apply */

/**
 * Claims the import for applying (VALIDATED → APPLYING, or a stalled APPLYING
 * again); a 409 when it is already being applied or is finished. The caller
 * then runs `runMediaImport` after responding.
 */
export async function startMediaImport(shopId: string, importId: string): Promise<void> {
  const [row] = await db
    .update(shopMediaImports)
    .set({ status: "APPLYING", lastProgressAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(shopMediaImports.id, importId),
        eq(shopMediaImports.shopId, shopId),
        or(
          eq(shopMediaImports.status, "VALIDATED"),
          and(
            eq(shopMediaImports.status, "APPLYING"),
            lt(shopMediaImports.lastProgressAt, new Date(Date.now() - STALLED_AFTER_MS)),
          ),
        ),
      ),
    )
    .returning({ id: shopMediaImports.id });
  if (!row) {
    const [current] = await db
      .select({ status: shopMediaImports.status })
      .from(shopMediaImports)
      .where(and(eq(shopMediaImports.id, importId), eq(shopMediaImports.shopId, shopId)));
    if (!current) throw notFound("Upload");
    if (current.status === "APPLYING") throw conflict("This upload is being applied now.");
    throw conflict(`This upload is already ${current.status.toLowerCase()}.`);
  }
}

async function setItem(id: string, values: Partial<typeof shopMediaImportItems.$inferInsert>) {
  await db.update(shopMediaImportItems).set({ ...values, updatedAt: new Date() }).where(eq(shopMediaImportItems.id, id));
}

async function progress(importId: string) {
  await db.update(shopMediaImports).set({ lastProgressAt: new Date(), updatedAt: new Date() }).where(eq(shopMediaImports.id, importId));
}

/**
 * Applies a claimed import: each product's photos in one transaction (all or
 * none for that product), then the descriptions. Items already APPLIED are
 * skipped, so a resumed run continues where it stopped.
 */
export async function runMediaImport(importId: string, actor: CatalogueActor): Promise<MediaImportView> {
  const [imp] = await db.select().from(shopMediaImports).where(eq(shopMediaImports.id, importId));
  if (!imp) throw notFound("Upload");
  const rules = await getRule("shopProductMedia");
  const pending = await db
    .select()
    .from(shopMediaImportItems)
    .where(and(eq(shopMediaImportItems.importId, importId), eq(shopMediaImportItems.status, "MATCHED")))
    .orderBy(asc(shopMediaImportItems.position), asc(shopMediaImportItems.sourceName));

  try {
    const photoItems = pending.filter((i) => i.kind === "PHOTO" && i.shopProductId);
    if (photoItems.length > 0) {
      if (!imp.archiveStorage) throw new Error("The ZIP for this upload is no longer stored.");
      const zip = await openZip(await readBlob({ storage: imp.archiveStorage, storageKey: imp.archiveKey, data: imp.archiveData }));
      const byListing = new Map<string, ShopMediaImportItem[]>();
      for (const item of photoItems) {
        const group = byListing.get(item.shopProductId!) ?? [];
        group.push(item);
        byListing.set(item.shopProductId!, group);
      }
      const moderationStatus = await initialStatus(actor);
      for (const [listingId, group] of byListing) {
        await applyListingPhotos(imp, listingId, group, zip, actor, moderationStatus, rules);
        await progress(importId);
      }
    }

    for (const item of pending.filter((i) => i.kind === "DESCRIPTION" && i.shopProductId)) {
      try {
        await db.transaction(async (tx) => {
          const locked = await lockListing(tx, item.shopProductId!);
          await writeDescriptions(tx, locked, item.payload ?? {}, actor, { importId });
        });
        await setItem(item.id, { status: "APPLIED", message: null });
      } catch (error) {
        await setItem(item.id, { status: "FAILED", message: error instanceof Error ? error.message : "Could not be saved." });
      }
      await progress(importId);
    }
    return await finishImport(imp, actor);
  } catch (error) {
    console.error("[media-import] apply failed", importId, error);
    await db
      .update(shopMediaImports)
      .set({ status: "FAILED", updatedAt: new Date() })
      .where(eq(shopMediaImports.id, importId));
    throw error;
  }
}

async function applyListingPhotos(
  imp: ShopMediaImport,
  listingId: string,
  group: ShopMediaImportItem[],
  zip: JSZip,
  actor: CatalogueActor,
  moderationStatus: "PENDING" | "APPROVED",
  rules: RuleValue<"shopProductMedia">,
) {
  const prepared: { item: ShopMediaImportItem; photo: Awaited<ReturnType<typeof processProductPhoto>>; blobs: Awaited<ReturnType<typeof storePhotoBlobs>> }[] = [];
  for (const item of group.sort((a, b) => (a.position ?? 99) - (b.position ?? 99))) {
    try {
      const entry = zip.file(item.sourceName);
      if (!entry) throw new Error("The file is missing from the ZIP.");
      const bytes = await readEntryCapped(entry, rules.maxUploadBytes);
      if (!bytes) throw new Error("Larger than the size limit.");
      const photo = await processProductPhoto(bytes, rules);
      prepared.push({ item, photo, blobs: await storePhotoBlobs(photo) });
    } catch (error) {
      await setItem(item.id, { status: "FAILED", message: error instanceof Error ? error.message : "Could not be processed." });
    }
  }
  if (prepared.length === 0) return;
  try {
    await db.transaction(async (tx) => {
      const listing = await lockListing(tx, listingId);
      if (imp.photoMode === "REPLACE") {
        const old = await listImages(listing.productId, listing.id, tx);
        for (const photo of old) {
          await tx.delete(productImages).where(eq(productImages.id, photo.id));
          await dropIfOrphaned(tx, photo.storedImageId);
        }
        if (old.length > 0) {
          await recordAudit(
            {
              actorId: actor.id,
              actorRole: actor.role,
              action: AUDIT_ACTIONS.SHOP_PRODUCT_MEDIA_CHANGED,
              entityType: "shop_product",
              entityId: listing.id,
              previousValue: { photos: old.map((o) => o.url) },
              newValue: { change: "photos_replaced_by_upload", importId: imp.id, via: actor.via },
            },
            tx,
          );
        }
      }
      for (const p of prepared) {
        const added = await attachProcessedPhoto(tx, listing, p.photo, p.blobs, actor, moderationStatus, rules.maxPhotos, {
          importId: imp.id,
          file: p.item.sourceName,
        });
        await tx
          .update(shopMediaImportItems)
          .set({ status: "APPLIED", productImageId: added.id, message: null, updatedAt: new Date() })
          .where(eq(shopMediaImportItems.id, p.item.id));
      }
    });
  } catch (error) {
    for (const p of prepared) {
      await discardPhotoBlobs(p.blobs);
      await setItem(p.item.id, { status: "FAILED", message: error instanceof Error ? error.message : "Could not be saved." });
    }
  }
}

async function finishImport(imp: ShopMediaImport, actor: CatalogueActor): Promise<MediaImportView> {
  const items = await db
    .select({ kind: shopMediaImportItems.kind, status: shopMediaImportItems.status })
    .from(shopMediaImportItems)
    .where(eq(shopMediaImportItems.importId, imp.id));
  const totals = countItems(items);
  const failed = totals.failed ?? 0;
  const applied = totals.applied ?? 0;
  const status = failed > 0 ? "PARTIAL" : "APPLIED";
  await db.transaction(async (tx) => {
    await tx
      .update(shopMediaImports)
      .set({
        status,
        totals,
        appliedAt: new Date(),
        archiveData: null,
        archiveKey: null,
        archiveStorage: null,
        updatedAt: new Date(),
      })
      .where(eq(shopMediaImports.id, imp.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_MEDIA_IMPORT_APPLIED,
        entityType: "shop_media_import",
        entityId: imp.id,
        newValue: { shopId: imp.shopId, status, totals, photoMode: imp.photoMode, via: actor.via },
      },
      tx,
    );
    const [shop] = await tx.select({ name: shops.name }).from(shops).where(eq(shops.id, imp.shopId));
    if (imp.uploadedBy) {
      await notify(
        {
          userId: imp.uploadedBy,
          type: NOTIFICATION_TYPES.SHOP_MEDIA_IMPORT_FINISHED,
          vars: { shopName: shop?.name ?? "Your shop", applied, failed },
          actionUrl: `/shop/media-import?shopId=${imp.shopId}&upload=${imp.id}`,
          dedupeKey: `media-import:${imp.id}`,
        },
        tx,
      );
    }
  });
  scheduleOrphanSweep([imp.archiveKey]);
  return getMediaImport(imp.shopId, imp.id);
}

export async function cancelMediaImport(shopId: string, importId: string): Promise<void> {
  const [before] = await db
    .select({ key: shopMediaImports.archiveKey })
    .from(shopMediaImports)
    .where(and(eq(shopMediaImports.id, importId), eq(shopMediaImports.shopId, shopId)));
  if (!before) throw notFound("Upload");
  const [row] = await db
    .update(shopMediaImports)
    .set({ status: "CANCELLED", archiveData: null, archiveKey: null, archiveStorage: null, updatedAt: new Date() })
    .where(and(eq(shopMediaImports.id, importId), eq(shopMediaImports.shopId, shopId), eq(shopMediaImports.status, "VALIDATED")))
    .returning({ id: shopMediaImports.id });
  if (!row) throw conflict("Only an upload that has not been applied can be cancelled.");
  scheduleOrphanSweep([before.key]);
}
