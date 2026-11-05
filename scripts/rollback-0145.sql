-- Rollback for 0145_shop_onboarding_steps (docs/onboarding-benchmark, Phase B funnel).
-- Before running: deploy the previous release's code. Then delete the 0145 row from
-- drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "shop_onboarding_steps";
COMMIT;
