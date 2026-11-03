-- Rollback for 0142_dealer_payout_tds_detail (gap report D3). Seller database (the one database
-- otherwise). Deploy the previous release's code first. Then delete the 0142 row from
-- drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE "dealer_payout_batches"
  DROP COLUMN IF EXISTS "tds_rate_id", DROP COLUMN IF EXISTS "tds_section", DROP COLUMN IF EXISTS "tds_certificate_id",
  DROP COLUMN IF EXISTS "tds_flag", DROP COLUMN IF EXISTS "tds_override_reason", DROP COLUMN IF EXISTS "tds_override_by";
COMMIT;
-- Split layout: the next migrate run re-imports the core's foreign tables (reconcile in scripts/split-migrate.mjs).
