-- Rollback for 0131_billing_gst_filings (docs/billing). Seller database.
-- Before running: deploy the previous release's code. Export first (filing evidence, keep 8 years):
--   \copy gst_filings TO 'gst_filings.csv' CSV HEADER
--   \copy ims_actions TO 'ims_actions.csv' CSV HEADER
-- Then delete the 0131 row from drizzle.__drizzle_migrations (both databases on the split layout).
BEGIN;
DROP TABLE IF EXISTS "ims_actions";
DROP TABLE IF EXISTS "gst_filings";
COMMIT;
