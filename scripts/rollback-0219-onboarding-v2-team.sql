-- Rollback of drizzle/0219_onboarding_v2_team.sql (docs/onboarding-v2-2026-11, Flow 4 My team).
-- Before running: deploy the previous release's code, then delete the 0219 row from
-- drizzle.__drizzle_migrations. Idempotent; drops only the index 0219 added.
BEGIN;
DROP INDEX IF EXISTS dealer_salespeople_active_user_unique;
COMMIT;
