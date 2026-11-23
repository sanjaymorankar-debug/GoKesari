-- Rollback for 0185_shop_staff_roles (Module 10; docs/shop-staff-roles-2026-11/).
-- Before running: turn shop_staff_roles_enabled off and deploy the previous release's code, then delete the 0185
-- row from drizzle.__drizzle_migrations. Invitations that were never accepted have no user and are removed; every
-- other row keeps working as catalogue staff (status INVITED/SUSPENDED rows are revoked so the old code ignores them).
DELETE FROM "shop_staff" WHERE "user_id" IS NULL;
UPDATE "shop_staff" SET "status" = 'REVOKED', "revoked_at" = COALESCE("revoked_at", now()) WHERE "status" IN ('INVITED', 'SUSPENDED');
ALTER TABLE "shop_staff" ALTER COLUMN "user_id" SET NOT NULL;
DROP INDEX IF EXISTS "shop_staff_invite_token_idx";
DROP INDEX IF EXISTS "shop_staff_one_open_email";
DROP INDEX IF EXISTS "shop_staff_one_open";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "role_changed_at";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "suspended_by";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "suspended_at";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "accepted_at";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "invited_by";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "invite_expires_at";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "invite_token_hash";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "invite_email";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "permissions";
ALTER TABLE "shop_staff" DROP COLUMN IF EXISTS "role";
DELETE FROM "feature_flags" WHERE "key" = 'shop_staff_roles_enabled';
-- Rollback for 0185_customer_whatsapp (customer WhatsApp; docs/customer-whatsapp-2026-11/README.md).
-- Before running: switch whatsapp_customer_enabled off, deploy the previous release's code, then run this and
-- delete the 0185 row of the migrations journal. The enum value WHATSAPP_NOTIFICATIONS stays (PostgreSQL cannot
-- drop it); unused it is inert. Consent rows of that type are kept as the DPDPA record (not deleted).
DROP TABLE IF EXISTS "whatsapp_cart_links";
DROP TABLE IF EXISTS "whatsapp_customer_sessions";
-- Customer messages must go before the old kind check can come back.
DELETE FROM "whatsapp_messages" WHERE "kind" IN ('CUSTOMER_NOTIFICATION', 'CUSTOMER_REPLY');
ALTER TABLE "whatsapp_messages" DROP CONSTRAINT IF EXISTS "whatsapp_messages_kind_check";
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_kind_check"
  CHECK ("kind" IN ('NEW_ORDER', 'STATUS_UPDATE', 'NUMBER_CHECK', 'REPLY'));
DROP INDEX IF EXISTS "whatsapp_messages_user_idx";
ALTER TABLE "whatsapp_messages" DROP COLUMN IF EXISTS "user_id";
ALTER TABLE "user_consents" DROP COLUMN IF EXISTS "source";
DELETE FROM "feature_flags" WHERE "key" = 'whatsapp_customer_enabled';
