-- SMS code at sign-in and a checkout step-up code (docs/sms-2fa-2026-11, 24-Nov-2026).
--
-- * feature flags sms_otp_signin_customers_enabled and sms_otp_signin_shop_owners_enabled, seeded OFF
--   (Admin → Sign-in security): with one on (and SMS codes available: SMS_PROVIDER + rule otp.smsEnabled),
--   that audience confirms every sign-in with a code sent by SMS to its verified mobile after the emailed
--   code. Off: email only, as before.
-- * login_otps.step_up_request_id: a verified CHECKOUT code (rule checkoutOtp, default off) is a one-time pass
--   for one order; the checkout request that used it is saved here.
-- login_otps.purpose is plain text: the new purposes LOGIN_SMS and CHECKOUT need no change.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0205.sql.
ALTER TABLE "login_otps" ADD COLUMN IF NOT EXISTS "step_up_request_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otps_user_purpose_consumed_idx" ON "login_otps" ("user_id", "purpose", "consumed_at") WHERE "consumed_at" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES
  ('sms_otp_signin_customers_enabled', false),
  ('sms_otp_signin_shop_owners_enabled', false)
ON CONFLICT DO NOTHING;
