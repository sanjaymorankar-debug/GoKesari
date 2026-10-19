-- Rollback for 0080_batch_b_dispatch (WS-B rider broadcast offers, pickup QR (F3.3.2, F4.1.3)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0080 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Broadcast offer history and pickup QR scans are lost.
BEGIN;
DROP TABLE IF EXISTS "delivery_pickup_scans" CASCADE;
DROP TABLE IF EXISTS "delivery_pickup_tokens" CASCADE;
DROP TABLE IF EXISTS "delivery_offer_recipients" CASCADE;
DROP TABLE IF EXISTS "delivery_offer_broadcasts" CASCADE;
COMMIT;
