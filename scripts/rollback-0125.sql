-- Rollback for 0125_billing_shop_gst_status (docs/billing). Seller database.
-- Before running: switch billing_v2 off (Admin → Feature flags) and deploy the previous release's
-- code. The columns hold only what the GST status step recorded; export them first if wanted:
--   SELECT id, gst_registration_type, gst_enrolment_id, gst_portal_status, gst_state_code, gst_portal_checked_at FROM shops;
-- Then delete the 0125 row from drizzle.__drizzle_migrations (in both databases on the split layout)
-- and re-import the core's foreign tables (scripts/split-migrate.mjs does it on the next build).
BEGIN;
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_gst_portal_status_check";
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_gst_registration_type_check";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "gst_portal_checked_at";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "gst_state_code";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "gst_portal_status";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "gst_enrolment_id";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "gst_registration_type";
COMMIT;
