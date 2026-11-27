-- Rollback of drizzle/0227_pico_xpress.sql (docs/pico-xpress-2026-11).
-- Deploy the previous release's code first, then run this and delete the 0227 row from drizzle.__drizzle_migrations.
-- Check first that no Pico shipment is live (cancel them with Pico before dropping the tables):
--   SELECT count(*) FROM delivery_shipments WHERE status NOT IN ('DELIVERED','RTO_DELIVERED','CANCELLED','LOST','DAMAGED');
-- The delivery_bookings rows of Pico shipments are kept (HDMS history); the AWB pool is dropped, so export it
-- first if the numbers should be kept:  \copy delivery_awb_pool TO 'awb_pool.csv' CSV HEADER
DELETE FROM "feature_flags" WHERE "key" IN ('delivery_partner_picoxpress_enabled', 'pico_live_location_enabled');
DELETE FROM "platform_settings" WHERE "key" = 'picoXpress';
DELETE FROM "delivery_providers" WHERE "code" = 'PICO' AND NOT EXISTS (SELECT 1 FROM "delivery_bookings" WHERE "provider_code" = 'PICO');
ALTER TABLE "order_fulfilment_arrangements" DROP CONSTRAINT IF EXISTS "order_fulfilment_arrangements_external_partner";
ALTER TABLE "order_fulfilment_arrangements" DROP COLUMN IF EXISTS "external_partner";
DROP TABLE IF EXISTS "delivery_partner_api_logs";
DROP TABLE IF EXISTS "delivery_location_pings";
DROP TABLE IF EXISTS "delivery_shipment_events";
DROP TABLE IF EXISTS "delivery_shipments";
DROP TABLE IF EXISTS "delivery_awb_pool";
