-- Rollback for 0202_shop_registration_subscription (docs/shop-registration-subscription-2026-11/).
-- Before running: deploy the previous release's code (the reminder job and admin screen go with it).
-- Then delete the 0202 row from drizzle.__drizzle_migrations.
--
-- Shops that got their first end date from this migration (registration_backfill END_DATE_SET) and have
-- not paid a renewal since go back to "no end date", with their LEGACY period; every other end date stays.
-- Payment links already sent stay payable at the gateway; a payment on one is still recorded by the
-- existing capture handlers (the link table is only bookkeeping).
DELETE FROM "shop_membership_periods" p
USING "shops" s
WHERE p."shop_id" = s."id" AND p."kind" = 'LEGACY' AND s."registration_backfill" LIKE '%END_DATE_SET%'
  AND NOT EXISTS (SELECT 1 FROM "shop_membership_periods" x WHERE x."shop_id" = s."id" AND x."kind" <> 'LEGACY');
UPDATE "shops" s SET "membership_valid_until" = NULL
WHERE s."registration_backfill" LIKE '%END_DATE_SET%'
  AND NOT EXISTS (SELECT 1 FROM "shop_membership_periods" x WHERE x."shop_id" = s."id");
DROP TABLE IF EXISTS "shop_registration_digests";
DROP TABLE IF EXISTS "shop_registration_migration_reports";
DROP TABLE IF EXISTS "shop_registration_reminders";
DROP TABLE IF EXISTS "shop_registration_links";
DROP INDEX IF EXISTS "shops_registration_status_idx";
ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_registration_status_check";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_backfill";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_status_at";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "last_registration_payment_at";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "last_registration_payment_id";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_reminders_enabled";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_grace_until";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_grace_days";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "renewal_fee_paise";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_start_date";
ALTER TABLE "shops" DROP COLUMN IF EXISTS "registration_status";
