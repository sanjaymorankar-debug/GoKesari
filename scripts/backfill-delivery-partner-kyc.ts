/**
 * One-off migration for SEC-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md):
 * encrypts delivery-partner KYC/bank details written before they were
 * encrypted at rest. DRY RUN unless --apply is given.
 *
 *   DATABASE_URL=<target> PAN_ENCRYPTION_KEY=<the host's base64 key> \
 *     [KYC_BACKFILL_ALLOW_REMOTE=1] \
 *     npx tsx scripts/backfill-delivery-partner-kyc.ts [--apply] [--null-plaintext --backup-taken]
 *
 *   (no flags)         report what would change; writes nothing
 *   --apply            write ciphertext next to each legacy plaintext value
 *   --null-plaintext   ALSO clear each plaintext value, but only after re-reading the stored
 *                      ciphertext and confirming it decrypts to exactly that value. Irreversible
 *                      without the key: requires --apply's run to have reported 0 mismatches, a
 *                      database backup, and --backup-taken as your acknowledgement of both.
 *
 * SAFETY: the app's .env is deliberately NOT loaded (in a developer's checkout it points at a hosted
 * database), so the target must be named explicitly, and a non-local host is refused unless
 * KYC_BACKFILL_ALLOW_REMOTE=1 is set on purpose. Idempotent; safe to re-run after every deploy.
 * Prints counts only, never a value.
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
  if (!LOCAL_HOSTS.has(target.hostname) && process.env.KYC_BACKFILL_ALLOW_REMOTE !== "1") {
    fail(
      `Refusing to run against non-local database host "${target.hostname}". ` +
        "Validate on a local database first; set KYC_BACKFILL_ALLOW_REMOTE=1 only when you mean it.",
    );
  }

  const apply = process.argv.includes("--apply");
  const nullPlaintext = process.argv.includes("--null-plaintext");
  if (nullPlaintext && !apply) fail("--null-plaintext requires --apply.");
  if (nullPlaintext && !process.argv.includes("--backup-taken")) {
    fail("--null-plaintext is irreversible without the key. Take a database backup, then pass --backup-taken.");
  }

  // Not used by this script, but the app's env validation requires them.
  process.env.AUTH_SECRET ??= "kyc-backfill-not-used";
  process.env.CRON_SECRET ??= "kyc-backfill-not-used";

  console.log(`target   ${target.protocol}//${target.host}${target.pathname}`);
  console.log(`mode     ${nullPlaintext ? "APPLY + NULL PLAINTEXT" : apply ? "APPLY (plaintext kept)" : "DRY RUN"}`);

  // Imported after the env is set: the db client reads it at import time.
  const { backfillDeliveryPartnerKyc } = await import("../src/server/services/delivery-partner-kyc");
  const result = await backfillDeliveryPartnerKyc({ apply, nullPlaintext });
  console.log(result);

  if (result.mismatches > 0) {
    console.error(
      `${result.mismatches} field(s) hold ciphertext that does NOT decrypt to their plaintext. ` +
        "They were left untouched. Check that PAN_ENCRYPTION_KEY matches the key used to encrypt them.",
    );
    process.exitCode = 2;
  }
  if (result.dryRun && result.fieldsEncrypted + result.fieldsAlreadyEncrypted > 0) {
    console.log("Dry run only — re-run with --apply to write.");
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
