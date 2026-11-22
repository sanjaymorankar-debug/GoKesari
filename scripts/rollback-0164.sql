-- Rollback for 0164_franchise_free_or_paid (owner 22-Nov-2026; docs/franchise/FREE_OR_PAID_FLOW.md).
-- Before running: deploy the previous release's code and settle any franchise still waiting for KYC (kyc_due_at set),
-- then delete the 0164 row from drizzle.__drizzle_migrations. Run before rollback-0157.sql.
UPDATE "franchise_zones" AS z
SET "name" = substr(z."name", length(regexp_replace(s."name", '\s*\(.*\)\s*$', '')) + 4), "updated_at" = now()
FROM "franchise_zone_sets" AS s
WHERE s."code" = z."zone_set_code" AND z."name" LIKE regexp_replace(s."name", '\s*\(.*\)\s*$', '') || ' – %';
DROP INDEX IF EXISTS "franchise_allocations_kyc_due_idx";
ALTER TABLE IF EXISTS "franchise_allocations" DROP COLUMN IF EXISTS "kyc_due_at";
ALTER TABLE IF EXISTS "franchise_allocations" DROP COLUMN IF EXISTS "kyc_cleared_at";
ALTER TABLE IF EXISTS "dealers" DROP COLUMN IF EXISTS "preferred_zone_id";
