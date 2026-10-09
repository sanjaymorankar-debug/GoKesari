/**
 * Where uploaded file bytes live (Module 1, docs/three-modules-2026-10).
 *
 *   MEDIA_DIR set   → DISK: a file under that folder, which must be OUTSIDE the
 *                     web root. Its name is random (32 hex characters) and
 *                     sharded two levels deep (ab/cd/abcd….webp); nothing a user
 *                     sends ever becomes part of a path. Files are written to a
 *                     temporary name and renamed, so a reader never sees half a
 *                     file, with owner-only permissions.
 *   MEDIA_DIR unset → DB: the bytes go in the row's `data` column, as before.
 *
 * Files are served only through GET /api/images/{id}, which applies the same
 * access rules whichever store holds them. A row records its own store, so
 * photos written before MEDIA_DIR was set keep working after it is.
 *
 * Deleting: a row is deleted inside a transaction that may still roll back,
 * so its file is not removed there. `scheduleOrphanSweep` checks a moment
 * after the transaction should have committed and unlinks a file only when no
 * row refers to it any more.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { shopMediaImports, storedImageVariants, storedImages } from "@/server/db/schema";

export type StorageKind = "DB" | "DISK";

export interface StoredBlob {
  storage: StorageKind;
  storageKey: string | null;
  data: Buffer | null;
}

export type BlobExtension = "webp" | "zip" | "csv";

const KEY_PATTERN = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}\.(webp|zip|csv)$/;

/**
 * The configured media folder, or null when files are kept in the database.
 * Read live (not from the cached env) so the folder can be switched without
 * other settings being re-parsed; validated by lib/env.ts like everything else.
 */
export function mediaRoot(): string | null {
  const dir = (process.env.MEDIA_DIR ?? getEnv().MEDIA_DIR ?? "").trim();
  if (!dir) return null;
  if (!path.isAbsolute(dir)) throw new Error("MEDIA_DIR must be an absolute path.");
  return dir;
}

/** Absolute path for a key. Refuses anything that is not a key this module made. */
function pathFor(root: string, key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid media storage key.");
  return path.join(root, ...key.split("/"));
}

/** Stores bytes in the configured store and says where they went. */
export async function putBlob(bytes: Buffer, ext: BlobExtension): Promise<StoredBlob> {
  const root = mediaRoot();
  if (!root) return { storage: "DB", storageKey: null, data: bytes };
  const name = randomBytes(16).toString("hex");
  const key = `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}.${ext}`;
  const full = pathFor(root, key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  const temp = `${full}.${process.pid}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
  await rename(temp, full);
  return { storage: "DISK", storageKey: key, data: null };
}

/** Reads bytes back from wherever a row says they are. */
export async function readBlob(blob: StoredBlob): Promise<Buffer> {
  if (blob.storage === "DB") {
    if (!blob.data) throw new Error("Stored file has no bytes.");
    return blob.data;
  }
  const root = mediaRoot();
  if (!root) throw new Error("This file is stored on disk, but MEDIA_DIR is not set.");
  if (!blob.storageKey) throw new Error("Stored file has no storage key.");
  return readFile(pathFor(root, blob.storageKey));
}

/** Removes a disk file now. Only for files no row was ever written for (a failed upload). */
export async function discardBlobs(blobs: StoredBlob[]): Promise<void> {
  const root = mediaRoot();
  if (!root) return;
  for (const blob of blobs) {
    if (blob.storage !== "DISK" || !blob.storageKey) continue;
    await unlink(pathFor(root, blob.storageKey)).catch(() => undefined);
  }
}

/** Unlinks each key that no row refers to any more. Returns how many files were removed. */
export async function sweepOrphanFiles(keys: string[]): Promise<number> {
  const root = mediaRoot();
  if (!root) return 0;
  let removed = 0;
  for (const key of new Set(keys)) {
    if (!KEY_PATTERN.test(key)) continue;
    const [image] = await db.select({ id: storedImages.id }).from(storedImages).where(eq(storedImages.storageKey, key)).limit(1);
    if (image) continue;
    const [variant] = await db
      .select({ id: storedImageVariants.id })
      .from(storedImageVariants)
      .where(eq(storedImageVariants.storageKey, key))
      .limit(1);
    if (variant) continue;
    const [archive] = await db
      .select({ id: shopMediaImports.id })
      .from(shopMediaImports)
      .where(eq(shopMediaImports.archiveKey, key))
      .limit(1);
    if (archive) continue;
    try {
      await unlink(pathFor(root, key));
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[media] could not remove", key, error);
    }
  }
  return removed;
}

/**
 * Removes files whose rows were deleted in a transaction that is about to
 * commit: runs shortly afterwards and keeps any file still referenced (the
 * transaction rolled back, or another row uses it).
 */
export function scheduleOrphanSweep(keys: (string | null | undefined)[]): void {
  const real = keys.filter((k): k is string => Boolean(k));
  if (real.length === 0 || !mediaRoot()) return;
  setTimeout(() => {
    void sweepOrphanFiles(real).catch((error) => console.error("[media] orphan sweep failed", error));
  }, 2_000).unref?.();
}
