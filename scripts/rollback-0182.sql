-- Rollback for 0182_subscription_plans (docs/subscription-plans-2026-11).
-- Before running: deploy the previous release's code, then delete the 0182 row from
-- drizzle.__drizzle_migrations.
-- Plan subscriptions are customers' standing orders and may carry a subscriber price. Check first:
--   SELECT count(*) FROM subscriptions WHERE plan_id IS NOT NULL AND status NOT IN ('CANCELLED', 'COMPLETED');
-- Rolled back, such a subscription stays but is charged the listing's online price, and a
-- subscription-only listing (not on sale online) stops delivering. Cancel or move them first.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE plan_id IS NOT NULL AND status NOT IN ('CANCELLED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'Live plan subscriptions exist: cancel or move them first';
  END IF;
END $$;
DROP INDEX IF EXISTS "subscriptions_plan_idx";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "plan_id";
DROP TABLE IF EXISTS "subscription_plans";
COMMIT;
