-- Reverses drizzle/0069_integrations.sql (Module 2: accounting integration).
-- Deploy the previous build first. Back up first: this drops every shop's
-- connection, item mapping, sync log and the sync queue. The shops' own
-- HSN/rate overrides on shop_products are dropped too.
-- Afterwards delete the 0069 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS integration_column_mappings;
DROP TABLE IF EXISTS integration_imports;
DROP TABLE IF EXISTS integration_sync_log;
DROP TABLE IF EXISTS integration_jobs;
DROP TABLE IF EXISTS integration_item_links;
DROP TABLE IF EXISTS integration_connector_tokens;
DROP TABLE IF EXISTS shop_integrations;
ALTER TABLE shop_products DROP COLUMN IF EXISTS external_synced_at;
ALTER TABLE shop_products DROP COLUMN IF EXISTS cess_bp;
ALTER TABLE shop_products DROP COLUMN IF EXISTS gst_rate_bp;
ALTER TABLE shop_products DROP COLUMN IF EXISTS hsn_code;
COMMIT;
