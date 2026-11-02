-- Rollback for 0130_billing_sync (docs/billing). Seller database.
-- Before running: deploy the previous release's code. The sync log only records what was exchanged;
-- export it first if wanted: \copy sync_records TO 'sync_records.csv' CSV HEADER
-- Then delete the 0130 row from drizzle.__drizzle_migrations (both databases on the split layout).
BEGIN;
DROP TABLE IF EXISTS "inv_unit_uqc";
DROP TABLE IF EXISTS "sync_conflicts";
DROP TABLE IF EXISTS "sync_records";
COMMIT;
