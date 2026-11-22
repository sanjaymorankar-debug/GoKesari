-- Rollback of drizzle/0169_whatsapp_shop_orders.sql. Drops only the new tables (their data is lost:
-- the WhatsApp message log, shop WhatsApp numbers and settings). Switch the flag
-- whatsapp_shop_orders_enabled off first.
DROP TABLE IF EXISTS "whatsapp_order_actions";
DROP TABLE IF EXISTS "whatsapp_webhook_events";
DROP TABLE IF EXISTS "whatsapp_messages";
DROP TABLE IF EXISTS "shop_whatsapp_contacts";
DROP TABLE IF EXISTS "shop_whatsapp_settings";
