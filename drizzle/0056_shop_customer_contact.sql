-- 0056 C1: the shop's own customer contact number and WhatsApp number.
--   Both nullable; customers see only these (rule shopContact), never the
--   registration/owner phone (shops.phone) or the owner's login number.
-- Additive. Rollback: scripts/rollback-0056.sql
ALTER TABLE "shops" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "whatsapp_number" text;