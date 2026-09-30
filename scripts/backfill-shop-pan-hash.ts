/**
 * One-off after migration 0024: fills shops.pan_hash for PANs submitted before
 * the column existed, so the duplicate-registration check and
 * scripts/shop-duplicate-report.sql can compare them. DRY RUN unless --apply.
 *
 *   DATABASE_URL=<target> PAN_ENCRYPTION_KEY=<that host's base64 key> \
 *     [SHOP_PAN_BACKFILL_ALLOW_REMOTE=1] \
 *     npx tsx scripts/backfill-shop-pan-hash.ts [--apply]
 *
 * The key must be the one the target's app encrypted its PANs with — a
 * different key reports every row as unreadable and writes nothing for them.
 *
 * SAFETY: the app's .env is deliberately NOT loaded (in a developer's checkout
 * it points at a hosted database), so the target must be named explicitly,
 * and a non-local host is refused unless SHOP_PAN_BACKFILL_ALLOW_REMOTE=1 is
 * set on purpose. Only pan_hash is written. Idempotent; prints counts only,
 * never a PAN.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set. Name the target database explicitly — this tool never loads .env.");
  if (!process.env.PAN_ENCRYPTION_KEY) {
    fail("PAN_ENCRYPTION_KEY is not set. Use the same key as the host this database belongs to.");
  }

  const target = new URL(url);
  if (!LOCAL_HOSTS.has(target.hostname) && process.env.SHOP_PAN_BACKFILL_ALLOW_REMOTE !== "1") {
    fail(
      `Refusing to run against non-local database host "${target.hostname}". ` +
        "Validate on a local database first; set SHOP_PAN_BACKFILL_ALLOW_REMOTE=1 only when you mean it.",
    );
  }

  const apply = process.argv.includes("--apply");

  // Not used by this script, but the app's env validation requires them.
  process.env.AUTH_SECRET ??= "pan-hash-backfill-not-used";
  process.env.CRON_SECRET ??= "pan-hash-backfill-not-used";

  console.log(`target   ${target.protocol}//${target.host}${target.pathname}`);
  console.log(`mode     ${apply ? "APPLY" : "DRY RUN"}`);

  // Imported after the env is set: the db client reads it at import time.
  const { backfillShopPanHashes } = await import("../src/server/services/shop-duplicates");
  const result = await backfillShopPanHashes({ apply });
  console.log(result);

  if (result.unreadable > 0) {
    console.error(
      `${result.unreadable} PAN(s) could not be read and were left without a hash. ` +
        "Check that PAN_ENCRYPTION_KEY matches the key this database's app uses.",
    );
    process.exitCode = 2;
  }
  if (result.dryRun && result.hashed > 0) console.log("Dry run only — re-run with --apply to write.");
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// A module, so its top-level names don't collide with the other scripts'.
export {};
