-- Rollback for 0187_brand_barcode_favourites (docs/search-brand-barcode-favourites-2026-11/).
-- Before running: switch the flag off (Admin → Feature flags), deploy the previous release's code, then
-- delete the 0187 row from drizzle.__drizzle_migrations. Dropping favourites deletes customers' saved
-- products: export the table first if they should be kept.
DROP INDEX IF EXISTS "brands_name_trgm_idx";
DROP TABLE IF EXISTS "favourites";
DELETE FROM "feature_flags" WHERE "key" = 'brand_barcode_favourites_enabled';
DELETE FROM "feature_flag_changes" WHERE "flag_key" = 'brand_barcode_favourites_enabled';
