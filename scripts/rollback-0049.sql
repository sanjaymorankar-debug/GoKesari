-- Reverses drizzle/0049_image_moderation.sql. Afterwards delete the 0049 row from drizzle.__drizzle_migrations.
-- Pending / rejected photos become visible again once the column is gone — delete them first if that is not wanted:
--   DELETE FROM product_images WHERE moderation_status <> 'APPROVED';
DROP INDEX IF EXISTS "product_images_moderation_idx";
ALTER TABLE "product_images" DROP CONSTRAINT IF EXISTS "product_images_moderated_by_users_id_fk";
ALTER TABLE "product_images" DROP COLUMN IF EXISTS "moderated_at", DROP COLUMN IF EXISTS "moderated_by",
  DROP COLUMN IF EXISTS "rejection_reason", DROP COLUMN IF EXISTS "moderation_status";
