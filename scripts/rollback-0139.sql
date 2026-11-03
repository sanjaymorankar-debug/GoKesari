-- Rollback for 0139_dealer_payouts_by_pan (gap report Part C). Seller database (the one database
-- otherwise). Before running: switch rule dealerAutoPayout off and deploy the previous release's
-- code; check nothing is in flight — this must return 0:
--   SELECT count(*) FROM dealer_payout_batches WHERE status IN ('APPROVED', 'PROCESSING', 'FAILED');
-- (pay them by hand or cancel them first). Then delete the 0139 row from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE "dealer_payout_batches" DROP CONSTRAINT IF EXISTS "dealer_payout_batches_status";
ALTER TABLE "dealer_payout_batches" ADD CONSTRAINT "dealer_payout_batches_status" CHECK ("status" in ('DRAFT', 'PAID', 'CANCELLED'));
DROP INDEX IF EXISTS "dealer_payout_batches_pan_idx";
DROP INDEX IF EXISTS "dealer_payout_batches_retry_idx";
DROP INDEX IF EXISTS "dealer_payout_batches_provider_ref_idx";
ALTER TABLE "dealer_payout_batches"
  DROP COLUMN IF EXISTS "payee_pan_hash", DROP COLUMN IF EXISTS "approved_by", DROP COLUMN IF EXISTS "approved_at",
  DROP COLUMN IF EXISTS "provider", DROP COLUMN IF EXISTS "provider_ref", DROP COLUMN IF EXISTS "attempts",
  DROP COLUMN IF EXISTS "next_retry_at", DROP COLUMN IF EXISTS "needs_review", DROP COLUMN IF EXISTS "failure_reason";
COMMIT;
-- Split layout: the next migrate run re-imports the core's foreign tables (reconcile in scripts/split-migrate.mjs).
