-- Rollback of drizzle/0212_shop_banner_upi_qr.sql (docs/shop-welcome-kit-2026-11).
-- Drops the uploaded banner payment QRs (owners would upload them again) and the safety-net rule row
-- (the rule falls back to its default: safety net off until safetyNetFrom is set again).
ALTER TABLE "inv_settings" DROP COLUMN IF EXISTS "banner_upi_qr";
DELETE FROM "platform_settings" WHERE "key" = 'shopWelcomeKit';
