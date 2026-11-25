-- Rollback for 0204_rider_app_v2 (docs/rider-app-v2-2026-11/README.md).
-- Before running: deploy the previous release's code (or turn every rider v2 rule off), then delete
-- the 0204_rider_app_v2 row from drizzle.__drizzle_migrations. Earnings already written keep their
-- amounts; only the quote / plan columns and the new tables go.
BEGIN;
DROP TABLE IF EXISTS "rider_sos_events";
DROP TABLE IF EXISTS "rider_nominees";
DROP TABLE IF EXISTS "rider_insurance_policies";
DROP TABLE IF EXISTS "rider_referrals";
DROP TABLE IF EXISTS "rider_slot_bookings";
DROP INDEX IF EXISTS "delivery_partners_referral_code_unique";
ALTER TABLE "delivery_partners" DROP COLUMN IF EXISTS "referred_by_partner_id";
ALTER TABLE "delivery_partners" DROP COLUMN IF EXISTS "referral_code";
ALTER TABLE "delivery_partner_earnings" DROP COLUMN IF EXISTS "plan_breakdown";
ALTER TABLE "delivery_partner_earnings" DROP COLUMN IF EXISTS "pay_plan_id";
ALTER TABLE "delivery_partner_earnings" DROP COLUMN IF EXISTS "quote_paise";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "reject_reason_code";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "quoted_at";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "pay_plan_id";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "quote_breakdown";
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "quote_paise";
ALTER TABLE "rider_earning_slots" DROP COLUMN IF EXISTS "booking_capacity";
ALTER TABLE "rider_earning_slots" DROP COLUMN IF EXISTS "bookable";
ALTER TABLE "rider_earning_slots" DROP COLUMN IF EXISTS "surge_multiplier_bp";
DROP TABLE IF EXISTS "rider_surges";
DROP TABLE IF EXISTS "rider_pay_plans";
COMMIT;
