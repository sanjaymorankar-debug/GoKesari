-- Rollback for 0082_batch_d_catalogue (WS-D Operator-Limited, manufacturer portal, ingestion (F8.4.2, F9.1.2, F9.1.4)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0082 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Onboarding sessions, manufacturer accounts/API keys, ingest jobs and imported image blobs are lost.
-- Not reversible: PostgreSQL cannot drop an enum value. Left in place (harmless to
-- the previous code, which never writes it): user_role.OPERATOR_LIMITED, shop_payment_method.ONLINE.
-- Before rolling back, move any OPERATOR_LIMITED user to another role:
--   UPDATE users SET role = 'CUSTOMER' WHERE role = 'OPERATOR_LIMITED';
--   UPDATE user_role_grants SET status = 'REVOKED', revoked_at = now() WHERE role = 'OPERATOR_LIMITED';
BEGIN;
ALTER TABLE "shops" DROP COLUMN IF EXISTS "onboarded_by_user_id";
DROP TABLE IF EXISTS "pmd_record_attributions" CASCADE;
DROP TABLE IF EXISTS "pmd_image_assets" CASCADE;
DROP TABLE IF EXISTS "pmd_object_blobs" CASCADE;
DROP TABLE IF EXISTS "pmd_ingest_job_rows" CASCADE;
DROP TABLE IF EXISTS "pmd_ingest_jobs" CASCADE;
DROP TABLE IF EXISTS "pmd_manufacturer_api_keys" CASCADE;
DROP TABLE IF EXISTS "pmd_manufacturer_members" CASCADE;
DROP TABLE IF EXISTS "pmd_manufacturer_accounts" CASCADE;
DROP TABLE IF EXISTS "shop_onboarding_sessions" CASCADE;
COMMIT;
