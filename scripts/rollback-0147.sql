-- Rollback for 0147_scheduled_notices (docs/onboarding-benchmark/phase-2, WP4).
-- Before running: deploy the previous release's code. Then delete the 0147 row from
-- drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "scheduled_notices";
COMMIT;
