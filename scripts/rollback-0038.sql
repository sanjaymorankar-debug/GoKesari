-- ============================================================================
-- Rollback of the product category management migration: drizzle/0039_product_category_management.sql
-- (numbered 0038 on staging before the merge with main's 0037_dispute_cases;
-- this script and the migration_0038_category_renames table keep that name).
--
-- Run on the target database inside one transaction (psql or the Neon SQL editor).
-- Take a backup first:
--     pg_dump "$DATABASE_URL" -Fc -t product_categories -t products \
--             -t shop_product_categories -f before-rollback-0038.dump
--
-- What it does:
--   * drops shop_product_categories (the shop <-> category links) — shops go
--     back to seeing products by shop type, as before 0038;
--   * drops the General protection trigger and the new columns/indexes;
--   * restores category names that 0038 renamed to make names unique;
--   * keeps "General" as an ordinary category if any product is in it (products
--     never lose their category), otherwise deletes it.
--
-- What it does NOT undo:
--   * a one-time categorisation run (scripts/categorise-products.ts --apply).
--     Undo that FIRST by restoring from the backup schema the apply step created:
--         npx tsx scripts/categorise-products.ts --restore <backup_schema_name>
--   * category removals done in the app (those products stay in General; the
--     removed categories stay soft-deleted). The audit log records each one.
-- ============================================================================
BEGIN;

DROP TRIGGER IF EXISTS product_categories_protect_system ON product_categories;
DROP FUNCTION IF EXISTS product_categories_protect_system();

DROP TABLE IF EXISTS shop_product_categories;

-- Delete General only when nothing references it.
DELETE FROM product_categories c
 WHERE c.is_system
   AND NOT EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM product_subcategories s WHERE s.category_id = c.id);

DROP INDEX IF EXISTS product_categories_name_live_unique;
DROP INDEX IF EXISTS product_categories_one_system;

-- Restore names 0038 changed (only where nobody has renamed them since).
UPDATE product_categories c
   SET name = r.old_name
  FROM migration_0038_category_renames r
 WHERE r.category_id = c.id AND c.name = r.new_name;
DROP TABLE IF EXISTS migration_0038_category_renames;

ALTER TABLE product_categories DROP CONSTRAINT IF EXISTS product_categories_created_by_users_id_fk;
ALTER TABLE product_categories DROP COLUMN IF EXISTS is_system;
ALTER TABLE product_categories DROP COLUMN IF EXISTS created_by;
ALTER TABLE product_categories DROP COLUMN IF EXISTS updated_at;

-- Let drizzle re-apply it later: forget that it ran, under either number
-- (1791025062254 = as 0038 on staging, 1791030174408 = as 0039 after the merge).
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (1791025062254, 1791030174408);

COMMIT;
