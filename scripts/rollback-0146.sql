-- Rollback for 0146_shop_delivery_choice (docs/onboarding-benchmark/phase-2, WP3).
-- Before running: deploy the previous release's code. Then delete the 0146 row from
-- drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_delivery_choice_check";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "delivery_choice";
COMMIT;
