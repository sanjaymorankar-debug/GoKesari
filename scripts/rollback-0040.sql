-- Reverses drizzle/0040_seller_verifications.sql. Destroys every seller
-- verification record and its history — back up first. Afterwards delete the
-- 0040 row from drizzle.__drizzle_migrations so the migration can run again.
DROP TABLE IF EXISTS "seller_verification_events";
DROP TABLE IF EXISTS "seller_verifications";
DROP FUNCTION IF EXISTS seller_verification_events_block_update();
DROP TYPE IF EXISTS "seller_verification_status";
DROP TYPE IF EXISTS "seller_doc_type";
