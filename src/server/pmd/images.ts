/**
 * Image fetch → resize → object store for imported product records
 * (batch-2026-10 WS-D, F9.1.4).
 *
 * Downloads go through the SSRF-safe fetcher of the shop bulk upload
 * (product-import/image-fetch.ts: public addresses only, checked at connect
 * time, size and time limits). The bytes are re-checked from their own magic
 * numbers, resized with sharp to `imageMaxEdgePx` (never enlarged) and stored
 * as WebP in the ObjectStore. One row per (source, record, URL) in
 * pmd_image_assets, so a re-run never fetches the same image twice.
 */
import sharp from "sharp";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { pmdImageAssets } from "@/server/db/schema";
import { fetchImage, ImageFetchError, type ImageFetcher } from "@/server/product-import/image-fetch";
import { detectImage } from "@/server/services/image-store";
import { getObjectStore, type ObjectStore } from "./object-store";

export interface ImageJobItem {
  sourceKey: string;
  sourceProductId: string;
  gtin14: string | null;
  urls: string[];
}

export interface ImageRunOptions {
  maxEdgePx: number;
  maxBytes: number;
  perRecord: number;
  jobId?: string | null;
  /** Replaced in tests. */
  fetcher?: ImageFetcher;
  store?: ObjectStore;
  timeoutMs?: number;
}

export async function resizeToWebp(input: Buffer, maxEdgePx: number): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (!detectImage(input)) throw new ImageFetchError("not a JPEG, PNG or WebP image", "TYPE");
  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })
    .rotate()
    .resize({ width: maxEdgePx, height: maxEdgePx, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

/** Fetches, resizes and stores each record's first `perRecord` images. Failures are recorded, never thrown. */
export async function storeRecordImages(items: ImageJobItem[], options: ImageRunOptions): Promise<{ stored: number; failed: number; skipped: number }> {
  const out = { stored: 0, failed: 0, skipped: 0 };
  if (options.perRecord <= 0) return out;
  const store = options.store ?? (await getObjectStore());
  const fetcher = options.fetcher ?? fetchImage;
  for (const item of items) {
    for (const url of item.urls.slice(0, options.perRecord)) {
      const [existing] = await db
        .select({ id: pmdImageAssets.id })
        .from(pmdImageAssets)
        .where(and(eq(pmdImageAssets.sourceKey, item.sourceKey), eq(pmdImageAssets.sourceProductId, item.sourceProductId), eq(pmdImageAssets.sourceUrl, url)));
      if (existing) {
        out.skipped += 1;
        continue;
      }
      try {
        const fetched = await fetcher(url, { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs ?? 10_000 });
        const resized = await resizeToWebp(fetched.bytes, options.maxEdgePx);
        const saved = await store.put({ prefix: `pmd/images/${item.sourceKey}`, bytes: resized.bytes, contentType: "image/webp", extension: "webp" });
        await db
          .insert(pmdImageAssets)
          .values({
            gtin14: item.gtin14,
            sourceProductId: item.sourceProductId,
            sourceKey: item.sourceKey,
            sourceUrl: url,
            objectStore: saved.store,
            objectKey: saved.key,
            width: resized.width,
            height: resized.height,
            sizeBytes: saved.sizeBytes,
            status: "STORED",
            jobId: options.jobId ?? null,
          })
          .onConflictDoNothing();
        out.stored += 1;
      } catch (error) {
        const reason = error instanceof ImageFetchError ? `${error.reason}: ${error.message}` : error instanceof Error ? error.message : "failed";
        await db
          .insert(pmdImageAssets)
          .values({
            gtin14: item.gtin14,
            sourceProductId: item.sourceProductId,
            sourceKey: item.sourceKey,
            sourceUrl: url,
            status: "FAILED",
            error: reason.slice(0, 500),
            jobId: options.jobId ?? null,
          })
          .onConflictDoNothing();
        out.failed += 1;
      }
    }
  }
  return out;
}
