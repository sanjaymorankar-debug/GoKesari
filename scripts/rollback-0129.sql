-- Rollback for 0129_billing_statutory_filings (docs/billing). Core database.
-- Before running: deploy the previous release's code. Export the filing record first (keep 8 years):
--   \copy statutory_filings TO 'statutory_filings.csv' CSV HEADER
-- Then delete the 0129 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "statutory_filings";
COMMIT;
