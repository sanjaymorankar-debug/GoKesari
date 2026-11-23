-- Rollback of drizzle/0183_hdms_delivery.sql. Switch hdms_enabled off first.
-- Drops only what 0183 added. Export delivery_bookings / delivery_events / delivery_settlements first if they
-- hold real deliveries: orders, delivery_orders, rider and wallet tables are never touched.
DROP TABLE IF EXISTS "delivery_reconciliation_lines";
DROP TABLE IF EXISTS "delivery_settlements";
DROP TABLE IF EXISTS "delivery_api_logs";
DROP TABLE IF EXISTS "delivery_webhook_logs";
DROP TABLE IF EXISTS "delivery_quotes";
DROP TABLE IF EXISTS "delivery_allocation_runs";
DROP TABLE IF EXISTS "delivery_events";
DROP TABLE IF EXISTS "delivery_bookings";
DROP TABLE IF EXISTS "delivery_pricing_rules";
DROP TABLE IF EXISTS "delivery_zones";
DROP TABLE IF EXISTS "delivery_providers";
DROP TABLE IF EXISTS "product_delivery_attributes";
ALTER TABLE "shop_delivery_staff" DROP CONSTRAINT IF EXISTS "shop_delivery_staff_kyc_status_chk";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "kyc_status";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "id_document_image_id";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "id_document_last4";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "id_document_type";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "vehicle_type";
ALTER TABLE "shop_delivery_staff" DROP COLUMN IF EXISTS "is_available";
DELETE FROM "feature_flags" WHERE "key" = 'hdms_enabled';
