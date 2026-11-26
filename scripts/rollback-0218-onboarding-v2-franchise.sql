-- Rollback of drizzle/0218_onboarding_v2_franchise.sql (docs/onboarding-v2-2026-11, Flow 3 franchise).
-- Switch the flag off first (Admin → Feature flags → onboarding_v2), deploy the previous release's code, then
-- delete the 0218 row from drizzle.__drizzle_migrations. Idempotent. The plan id (0215) stays on each booking.
ALTER TABLE "franchise_bookings" DROP COLUMN IF EXISTS "plan_price_per_zone_paise";
ALTER TABLE "franchise_bookings" DROP COLUMN IF EXISTS "plan_duration_months";
ALTER TABLE "franchise_bookings" DROP COLUMN IF EXISTS "plan_code";
