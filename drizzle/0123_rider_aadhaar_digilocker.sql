-- split: core
-- Rider Aadhaar by DigiLocker, 31 Oct 2026 — docs/gig-worker-2026-10/README.md "KYC provider".
-- Sandbox.co.in stopped Aadhaar offline e-KYC (OTP); a rider now shares the Aadhaar from DigiLocker.
-- delivery_partner_kyc_checks is a platform table on the core database. Additive only (nullable
-- columns, one index), so the previous release keeps working against it. Idempotent.
-- Nothing personal is added: the session id is Sandbox's, the link expires within the hour, and
-- the Aadhaar number, photo, XML, date of birth and address are still never stored (the
-- "aadhaar_never_stored" check stays as it is).
-- Rollback: scripts/rollback-0123.sql

-- How the Aadhaar was checked: 'digilocker', 'okyc_legacy' (OTP, before Nov 2026) or 'manual'.
-- Null on rows written before this migration (they were all OTP checks).
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "method" text;--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" DROP CONSTRAINT IF EXISTS "delivery_partner_kyc_checks_method_check";--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" ADD CONSTRAINT "delivery_partner_kyc_checks_method_check" CHECK ("method" IS NULL OR "method" IN ('digilocker', 'okyc_legacy', 'manual'));--> statement-breakpoint
-- The DigiLocker session: Sandbox's id, its last known status, the link the rider opens, when it
-- stops working, and the random value in our return link (the return page needs no sign-in).
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "session_status" text;--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "session_url" text;--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "session_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_partner_kyc_checks" ADD COLUMN IF NOT EXISTS "session_return_key" text;--> statement-breakpoint
-- The webhook finds the check by Sandbox's session id.
CREATE INDEX IF NOT EXISTS "delivery_partner_kyc_checks_session_idx" ON "delivery_partner_kyc_checks" ("session_id");
