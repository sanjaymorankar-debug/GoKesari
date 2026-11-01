-- Rollback for 0132_billing_gsp_log (docs/billing). Core database.
-- Before running: deploy the previous release's code. Export first (audit trail, keep 8 years):
--   \copy gsp_call_log TO 'gsp_call_log.csv' CSV HEADER
--   \copy credit_note_einvoices TO 'credit_note_einvoices.csv' CSV HEADER
-- Then delete the 0132 row from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE "eway_bills" DROP COLUMN IF EXISTS "cancel_reason";
ALTER TABLE "eway_bills" DROP COLUMN IF EXISTS "cancelled_at";
ALTER TABLE "eway_bills" DROP COLUMN IF EXISTS "extensions";
ALTER TABLE "eway_bills" DROP COLUMN IF EXISTS "part_b_updated_at";
DROP TABLE IF EXISTS "credit_note_einvoices";
DROP TABLE IF EXISTS "gsp_call_log";
COMMIT;
