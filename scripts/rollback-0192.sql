-- Rollback for 0192_onboarding_waves_2_3 (onboarding Phase 2 Waves 2–3; docs/onboarding-waves-2-3-2026-11/).
-- Before running: deploy the previous release's code (which does not read these columns or flags), then delete
-- the 0192 row from drizzle.__drizzle_migrations. Assisted-draft history (who helped) is lost; the audit log keeps it.
DROP INDEX IF EXISTS "shop_registration_drafts_assisted_idx";
ALTER TABLE "shop_registration_drafts" DROP CONSTRAINT IF EXISTS "shop_registration_drafts_assisted_role";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "assisted_session_id";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "assisted_role";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "assisted_by_user_id";
DELETE FROM "feature_flag_changes" WHERE "flag_key" IN ('onboarding_referral_by_pin_enabled', 'onboarding_assisted_mode_enabled', 'onboarding_scan_first_enabled');
DELETE FROM "feature_flags" WHERE "key" IN ('onboarding_referral_by_pin_enabled', 'onboarding_assisted_mode_enabled', 'onboarding_scan_first_enabled');
