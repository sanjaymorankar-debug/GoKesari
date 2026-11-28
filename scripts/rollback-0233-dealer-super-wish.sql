-- Rollback of drizzle/0233_dealer_super_wish.sql (owner's OK first; production: after a backup).
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "wants_super_by";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "wants_super_at";
-- Then delete the 0233 row from drizzle.__drizzle_migrations (created_at 1793273300000).
