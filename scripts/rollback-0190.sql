-- Rollback for 0190_sms_two_factor (SMS sign-in code flags, checkout step-up column).
-- Before running: deploy the previous release's code. Then delete the 0190 row.
DELETE FROM "feature_flag_changes" WHERE "flag_key" IN ('sms_otp_signin_customers_enabled', 'sms_otp_signin_shop_owners_enabled');
DELETE FROM "feature_flags" WHERE "key" IN ('sms_otp_signin_customers_enabled', 'sms_otp_signin_shop_owners_enabled');
DROP INDEX IF EXISTS "login_otps_user_purpose_consumed_idx";
ALTER TABLE "login_otps" DROP COLUMN IF EXISTS "step_up_request_id";
