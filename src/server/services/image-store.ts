/**
 * Image storage and validation (product photos, return evidence).
 *
 * The browser downsizes and re-encodes before upload; the server does not
 * trust that and re-checks everything: real file type from the bytes (never
 * the filename or declared type), size, and pixel dimensions. Accepted:
 * JPEG, PNG, WebP. Images are recorded in stored_images and served by
 * GET /api/images/{id}. Their bytes are in the row (storage DB) or, for
 * product photos processed by Module 1, in a file under MEDIA_DIR
 * (storage DISK) — see server/media/blob-store.ts.
 */
import { createHash } from "node:crypto";

import { and, eq, getTableColumns } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { storedImageVariants, storedImages, type StoredImage } from "@/server/db/schema";
import { putBlob, discardBlobs, readBlob, type StoredBlob } from "@/server/media/blob-store";
import type { ProcessedPhoto } from "@/server/media/photo-pipeline";
import { getRule } from "./settings";

export type ImagePurpose = StoredImage["purpose"];

interface Detected {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

/** Reads type and dimensions from the file header; null when it is not a well-formed JPEG/PNG/WebP. */
export function detectImage(buf: Buffer): Detected | null {
  // PNG: signature, then IHDR with width/height at bytes 16..23.
  if (buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { contentType: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the marker segments to the first start-of-frame.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      const length = buf.readUInt16BE(offset + 2);
      if (isSof) {
        return { contentType: "image/jpeg", height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  // WebP: RIFF....WEBP then a VP8 / VP8L / VP8X chunk.
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return { contentType: "image/webp", width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 ") {
      return { contentType: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export async function saveImage(
  data: Buffer,
  input: { purpose: ImagePurpose; ownerId: string },
  client: DbClient = db,
): Promise<StoredImage> {
  const limits = await getRule("images");
  if (data.length === 0) throw validationFailed("The image file is empty.");
  if (data.length > limits.maxBytes) {
    throw validationFailed(`Images can be at most ${(limits.maxBytes / 1_000_000).toFixed(1)} MB.`);
  }
  const detected = detectImage(data);
  if (!detected) throw validationFailed("Upload a JPEG, PNG or WebP image.");
  if (detected.width < limits.minDimensionPx || detected.height < limits.minDimensionPx) {
    throw validationFailed(`The image is too small — at least ${limits.minDimensionPx}px on each side.`);
  }
  if (detected.width > limits.maxDimensionPx || detected.height > limits.maxDimensionPx) {
    throw validationFailed(`The image is too large — at most ${limits.maxDimensionPx}px on each side.`);
  }

  const [row] = await client
    .insert(storedImages)
    .values({
      ownerId: input.ownerId,
      purpose: input.purpose,
      contentType: detected.contentType,
      sizeBytes: data.length,
      width: detected.width,
      height: detected.height,
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    })
    .returning();
  return row;
}

export async function getImage(id: string): Promise<StoredImage> {
  const [row] = await db.select().from(storedImages).where(eq(storedImages.id, id));
  if (!row) throw notFound("Image");
  return row;
}

/* ------------------------------------------- Module 1: processed photos */

const metaColumns = (() => {
  const { data, ...rest } = getTableColumns(storedImages);
  void data;
  return rest;
})();
export type StoredImageMeta = Omit<StoredImage, "data">;

/** An image's record without its bytes (for access checks before reading anything). */
export async function getImageMeta(id: string): Promise<StoredImageMeta> {
  const [row] = await db.select(metaColumns).from(storedImages).where(eq(storedImages.id, id));
  if (!row) throw notFound("Image");
  return row;
}

export type ImageSize = "thumb" | "medium" | "large";

export interface ServableImage {
  bytes: Buffer;
  contentType: string;
  /** Strong validator for conditional requests: the file's hash plus the size served. */
  etag: string;
}

/**
 * The bytes to serve for an image at a size. THUMB/MEDIUM come from the
 * variants a processed photo has; anything without variants (older uploads,
 * return photos) is served at its only size.
 */
export async function readImageBytes(meta: StoredImageMeta, size: ImageSize | null): Promise<ServableImage> {
  if (size === "thumb" || size === "medium") {
    const [variant] = await db
      .select()
      .from(storedImageVariants)
      .where(and(eq(storedImageVariants.storedImageId, meta.id), eq(storedImageVariants.variant, size === "thumb" ? "THUMB" : "MEDIUM")));
    if (variant) {
      return { bytes: await readBlob(variant), contentType: variant.contentType, etag: `"${meta.sha256.slice(0, 32)}-${size}"` };
    }
  }
  let blob: StoredBlob = { storage: meta.storage, storageKey: meta.storageKey, data: null };
  if (meta.storage === "DB") {
    const [row] = await db.select({ data: storedImages.data }).from(storedImages).where(eq(storedImages.id, meta.id));
    blob = { ...blob, data: row?.data ?? null };
  }
  return { bytes: await readBlob(blob), contentType: meta.contentType, etag: `"${meta.sha256.slice(0, 32)}"` };
}

export interface StoredPhotoBlobs {
  large: StoredBlob;
  medium: StoredBlob;
  thumb: StoredBlob;
}

/** Writes a processed photo's three files to the media store (before any transaction). */
export async function storePhotoBlobs(photo: ProcessedPhoto): Promise<StoredPhotoBlobs> {
  const written: StoredBlob[] = [];
  try {
    const large = await putBlob(photo.large.data, "webp");
    written.push(large);
    const medium = await putBlob(photo.medium.data, "webp");
    written.push(medium);
    const thumb = await putBlob(photo.thumb.data, "webp");
    written.push(thumb);
    return { large, medium, thumb };
  } catch (error) {
    await discardBlobs(written);
    throw error;
  }
}

/** Removes files written by storePhotoBlobs when the rows for them were never committed. */
export async function discardPhotoBlobs(blobs: StoredPhotoBlobs): Promise<void> {
  await discardBlobs([blobs.large, blobs.medium, blobs.thumb]);
}

/** Records a processed photo (LARGE as the image, THUMB and MEDIUM as variants). */
export async function insertProcessedPhoto(
  photo: ProcessedPhoto,
  blobs: StoredPhotoBlobs,
  ownerId: string,
  client: DbClient,
): Promise<StoredImageMeta> {
  const [row] = await client
    .insert(storedImages)
    .values({
      ownerId,
      purpose: "PRODUCT",
      contentType: "image/webp",
      sizeBytes: photo.large.sizeBytes,
      width: photo.large.width,
      height: photo.large.height,
      sha256: photo.sha256,
      storage: blobs.large.storage,
      storageKey: blobs.large.storageKey,
      data: blobs.large.data,
    })
    .returning(metaColumns);
  await client.insert(storedImageVariants).values([
    {
      storedImageId: row.id,
      variant: "MEDIUM",
      contentType: "image/webp",
      sizeBytes: photo.medium.sizeBytes,
      width: photo.medium.width,
      height: photo.medium.height,
      storage: blobs.medium.storage,
      storageKey: blobs.medium.storageKey,
      data: blobs.medium.data,
    },
    {
      storedImageId: row.id,
      variant: "THUMB",
      contentType: "image/webp",
      sizeBytes: photo.thumb.sizeBytes,
      width: photo.thumb.width,
      height: photo.thumb.height,
      storage: blobs.thumb.storage,
      storageKey: blobs.thumb.storageKey,
      data: blobs.thumb.data,
    },
  ]);
  return row;
}

/** Disk keys of an image and its variants, read before the rows are deleted. */
export async function storageKeysOf(storedImageId: string, client: DbClient = db): Promise<string[]> {
  const [image] = await client
    .select({ key: storedImages.storageKey })
    .from(storedImages)
    .where(eq(storedImages.id, storedImageId));
  const variants = await client
    .select({ key: storedImageVariants.storageKey })
    .from(storedImageVariants)
    .where(eq(storedImageVariants.storedImageId, storedImageId));
  return [image?.key, ...variants.map((v) => v.key)].filter((k): k is string => Boolean(k));
}

/** URL a page uses to show a stored image. */
export const imageUrl = (id: string) => `/api/images/${id}`;
