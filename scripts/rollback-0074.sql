-- Rollback for 0074_referral_settings (docs/nearby-referral-2026-10, feature 2).
-- Run only after the previous code is live, then delete the 0074 row from
-- drizzle.__drizzle_migrations. The referral-setting change log is lost — back up first.
-- Self-registrations made without a referral code (referral_code_id NULL) must be
-- given a code or cancelled before NOT NULL can be restored; this script stops if any exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "shop_registrations" WHERE "referral_code_id" IS NULL) THEN
    RAISE EXCEPTION 'shop_registrations without a referral code exist; resolve them first';
  END IF;
END $$;
ALTER TABLE "shop_registrations" ALTER COLUMN "referral_code_id" SET NOT NULL;
DROP TABLE IF EXISTS "referral_setting_changes";
DROP TABLE IF EXISTS "referral_settings";
