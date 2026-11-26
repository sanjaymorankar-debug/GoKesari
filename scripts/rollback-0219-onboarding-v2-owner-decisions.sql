-- Rollback of drizzle/0219_onboarding_v2_owner_decisions.sql (docs/onboarding-v2-2026-11, owner decisions 27-Nov-2026).
-- Deploy the previous release's code first, then run this and delete the 0219 row from drizzle.__drizzle_migrations.
-- Idempotent. Dropping signature_method loses which acceptances were made at registration without an OTP: export
-- them first (SELECT id, shop_id FROM legal_acceptances WHERE signature_method = 'REGISTRATION_ACCEPT').
DROP INDEX IF EXISTS "shop_suspensions_source_active_idx";
ALTER TABLE "shop_suspensions" DROP COLUMN IF EXISTS "source";
ALTER TABLE "legal_signing_requests" DROP CONSTRAINT IF EXISTS "legal_signing_requests_signature_method_check";
ALTER TABLE "legal_acceptances" DROP CONSTRAINT IF EXISTS "legal_acceptances_signature_method_check";
ALTER TABLE "legal_signing_requests" DROP COLUMN IF EXISTS "signature_method";
ALTER TABLE "legal_acceptances" DROP COLUMN IF EXISTS "signature_method";
