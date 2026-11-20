-- Rollback for 0152_newspaper_subscriptions (docs/newspaper-subscriptions-2026-11).
-- Before running: deploy the previous release's code, then delete the 0152 row from
-- drizzle.__drizzle_migrations.
-- Checks first: MONTHLY subscriptions and grouped subscriptions are customers' standing orders.
-- Export them and cancel them in the app before rolling back:
--   SELECT count(*) FROM subscriptions WHERE frequency = 'MONTHLY';
--   SELECT count(*) FROM subscriptions WHERE bundle_id IS NOT NULL;
-- The 'MONTHLY' enum value cannot be dropped in place; it stays (unused) after rollback.
-- The starter titles and their two categories are left in the catalogue: shops may list them.
-- Remove them by hand only when no shop_products row points at them.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE frequency = 'MONTHLY' AND status NOT IN ('CANCELLED', 'COMPLETED')) THEN
    RAISE EXCEPTION 'Live MONTHLY subscriptions exist: cancel or change them first';
  END IF;
END $$;
DROP TABLE IF EXISTS "periodical_titles";
DROP INDEX IF EXISTS "subscriptions_bundle_idx";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "bundle_id";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "month_days";
COMMIT;
