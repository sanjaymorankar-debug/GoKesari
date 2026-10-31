-- Rollback of drizzle/0123_rider_aadhaar_digilocker.sql (core database). Drops only what 0123 added.
DROP INDEX IF EXISTS "delivery_partner_kyc_checks_session_idx";
ALTER TABLE "delivery_partner_kyc_checks" DROP CONSTRAINT IF EXISTS "delivery_partner_kyc_checks_method_check";
ALTER TABLE "delivery_partner_kyc_checks"
  DROP COLUMN IF EXISTS "session_return_key",
  DROP COLUMN IF EXISTS "session_expires_at",
  DROP COLUMN IF EXISTS "session_url",
  DROP COLUMN IF EXISTS "session_status",
  DROP COLUMN IF EXISTS "session_id",
  DROP COLUMN IF EXISTS "method";
