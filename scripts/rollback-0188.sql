-- Rollback for 0188_customer_whatsapp (customer WhatsApp; docs/customer-whatsapp-2026-11/README.md).
-- Before running: switch whatsapp_customer_enabled off, deploy the previous release's code, then run this and
-- delete the 0188 row of the migrations journal. The enum value WHATSAPP_NOTIFICATIONS stays (PostgreSQL cannot
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
