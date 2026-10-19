-- Rollback for 0087_search_trigram_indexes (homepage UI/UX upgrade: search suggestion indexes).
-- Seller database on the split layout, the one database otherwise. Index-only:
-- no data is lost. Then delete the 0087 row from drizzle.__drizzle_migrations.
-- pg_trgm stays installed (the product master's indexes use it).
BEGIN;
DROP INDEX IF EXISTS "products_name_trgm_idx";
DROP INDEX IF EXISTS "shops_name_trgm_idx";
COMMIT;
