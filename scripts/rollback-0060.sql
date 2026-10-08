-- Reverses drizzle/0060_shop_product_media.sql (Module 1: shop product photos
-- and descriptions). Deploy the previous build first.
-- Back up first: this drops shop staff, bulk-upload history, photo variants and
-- the shops' own short/long descriptions.
--
-- Photos stored on disk (storage = 'DISK') have no bytes in the database, and
-- the previous build requires stored_images.data. Copy them in first:
--   DATABASE_URL=<db> MEDIA_DIR=<dir> npx tsx scripts/media-to-db.ts --apply
-- The block below refuses to run while any remain.
-- Afterwards delete the 0060 row from drizzle.__drizzle_migrations.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM stored_images WHERE storage <> 'DB' OR data IS NULL) THEN
    RAISE EXCEPTION 'Some images are stored on disk: run scripts/media-to-db.ts --apply first.';
  END IF;
END $$;
DROP TABLE IF EXISTS shop_media_import_items;
DROP TABLE IF EXISTS shop_media_imports;
DROP TABLE IF EXISTS shop_staff;
DROP TABLE IF EXISTS stored_image_variants;
ALTER TABLE stored_images DROP CONSTRAINT IF EXISTS stored_images_bytes_present;
ALTER TABLE stored_images DROP COLUMN IF EXISTS storage_key;
ALTER TABLE stored_images DROP COLUMN IF EXISTS storage;
ALTER TABLE stored_images ALTER COLUMN data SET NOT NULL;
ALTER TABLE shop_products DROP CONSTRAINT IF EXISTS shop_products_content_updated_by_users_id_fk;
ALTER TABLE shop_products DROP COLUMN IF EXISTS content_updated_by;
ALTER TABLE shop_products DROP COLUMN IF EXISTS content_updated_at;
ALTER TABLE shop_products DROP COLUMN IF EXISTS long_description;
ALTER TABLE shop_products DROP COLUMN IF EXISTS short_description;
COMMIT;
