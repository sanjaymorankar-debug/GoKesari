-- Onboarding v2 — the owner's decisions of 27-Nov-2026 (docs/onboarding-v2-2026-11). Flag `onboarding_v2`.
--
-- * legal_acceptances / legal_signing_requests.signature_method: how the agreement was signed. 'SMS_OTP' — the
--   existing e-sign with the SMS code (every existing row, and every review / re-sign from the shop dashboard);
--   'REGISTRATION_ACCEPT' — accepted at the v2 shop registration with the ticks and the owner's typed name, no OTP
--   (owner: "while shop registration to see the terms and condition OTP is not required").
-- * shop_suspensions.source: what suspended the shop. 'DOCUMENT_FOLLOW_UP' — the automatic documents follow-up
--   (runShopDocumentFollowUp); with onboarding_v2 on, such a shop is reinstated automatically once nothing is chased
--   any more. NULL on every existing row and on every other suspension (never reinstated automatically).
--
-- Additive (constant defaults: no row rewrite, so the insert-only trigger of legal_acceptances never fires) and safe
-- to re-run. Rollback: scripts/rollback-0220-onboarding-v2-owner-decisions.sql.
ALTER TABLE "legal_acceptances" ADD COLUMN IF NOT EXISTS "signature_method" text NOT NULL DEFAULT 'SMS_OTP';
--> statement-breakpoint
ALTER TABLE "legal_signing_requests" ADD COLUMN IF NOT EXISTS "signature_method" text NOT NULL DEFAULT 'SMS_OTP';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_acceptances_signature_method_check') THEN
    ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_signature_method_check" CHECK ("signature_method" IN ('SMS_OTP', 'REGISTRATION_ACCEPT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_signing_requests_signature_method_check') THEN
    ALTER TABLE "legal_signing_requests" ADD CONSTRAINT "legal_signing_requests_signature_method_check" CHECK ("signature_method" IN ('SMS_OTP', 'REGISTRATION_ACCEPT'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "shop_suspensions" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_suspensions_source_active_idx" ON "shop_suspensions" ("source") WHERE "status" = 'ACTIVE' AND "source" IS NOT NULL;
