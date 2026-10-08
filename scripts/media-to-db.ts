/**
 * Copies product photos kept on disk (MEDIA_DIR, storage = 'DISK') into the
 * database (storage = 'DB'), for rolling back migration 0060 or leaving disk
 * storage. DRY RUN unless --apply. Files are not deleted; remove the folder
 * yourself once the app no longer needs it.
 *
 *   DATABASE_URL=<target> MEDIA_DIR=<that host's folder> \
 *     [MEDIA_TO_DB_ALLOW_REMOTE=1] npx tsx scripts/media-to-db.ts [--apply]
 *
 * SAFETY: the app's .env is deliberately NOT loaded, so the target must be
 * named explicitly, and a non-local database host is refused unless
 * MEDIA_TO_DB_ALLOW_REMOTE=1 is set on purpose. Idempotent; prints counts only.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set. Name the target database explicitly — this tool never loads .env.");
  if (!process.env.MEDIA_DIR) fail("MEDIA_DIR is not set. Use the folder the target host writes photos to.");
  const target = new URL(url);
  if (!LOCAL_HOSTS.has(target.hostname) && process.env.MEDIA_TO_DB_ALLOW_REMOTE !== "1") {
    fail(`Refusing to run against non-local database host "${target.hostname}" without MEDIA_TO_DB_ALLOW_REMOTE=1.`);
  }
  const apply = process.argv.includes("--apply");

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/server/db");
  const { storedImages, storedImageVariants } = await import("../src/server/db/schema");
  const { readBlob } = await import("../src/server/media/blob-store");

  const tally = { images: 0, variants: 0, missing: 0 };
  const images = await db
    .select({ id: storedImages.id, storageKey: storedImages.storageKey })
    .from(storedImages)
    .where(eq(storedImages.storage, "DISK"));
  for (const row of images) {
    try {
      const data = await readBlob({ storage: "DISK", storageKey: row.storageKey, data: null });
      if (apply) await db.update(storedImages).set({ storage: "DB", data, storageKey: null }).where(eq(storedImages.id, row.id));
      tally.images += 1;
    } catch {
      tally.missing += 1;
    }
  }
  const variants = await db
    .select({ id: storedImageVariants.id, storageKey: storedImageVariants.storageKey })
    .from(storedImageVariants)
    .where(eq(storedImageVariants.storage, "DISK"));
  for (const row of variants) {
    try {
      const data = await readBlob({ storage: "DISK", storageKey: row.storageKey, data: null });
      if (apply) {
        await db.update(storedImageVariants).set({ storage: "DB", data, storageKey: null }).where(eq(storedImageVariants.id, row.id));
      }
      tally.variants += 1;
    } catch {
      tally.missing += 1;
    }
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...tally }));
  if (tally.missing > 0) console.error(`${tally.missing} file(s) could not be read from MEDIA_DIR; those rows were left as they are.`);
  process.exit(0);
}

void main();
export {};
