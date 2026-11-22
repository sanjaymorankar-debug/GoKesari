-- Rollback of drizzle/0168_shop_photo_listing.sql. Drops only the new tables (the AI-vs-published records and any
-- draft photos are lost). Products and shop listings created through the feature stay: they are ordinary rows.
-- Also remove the migration's journal row if the migration is to be re-applied later:
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1793266600000;
DROP TABLE IF EXISTS "shop_photo_listing_photos";
DROP TABLE IF EXISTS "shop_photo_listings";
