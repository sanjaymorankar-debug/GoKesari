-- Smart shopping, feature 3 (owner brief 22-Nov-2026; docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md):
-- new orders on the shop owner's WhatsApp with Accept / Reject buttons. Additive and safe to re-run.
-- Shop-side tables reference shops (seller side) only; orders and users are not referenced by foreign key
-- (the service checks those links). Feature flag whatsapp_shop_orders_enabled: a missing row is OFF.
-- Rollback: scripts/rollback-0169.sql.
CREATE TABLE IF NOT EXISTS "shop_whatsapp_settings" (
  "shop_id" uuid PRIMARY KEY REFERENCES "shops"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_whatsapp_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "phone_e164" text NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('OWNER', 'STAFF')),
  "label" text,
  "opted_in" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'UNCHECKED' CHECK ("status" IN ('UNCHECKED', 'CHECKING', 'ACTIVE', 'NOT_ON_WHATSAPP')),
  "check_message_id" uuid,
  "check_sent_at" timestamp with time zone,
  "verified_at" timestamp with time zone,
  "last_error" text,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_whatsapp_contacts_live_uq" ON "shop_whatsapp_contacts" ("shop_id", "phone_e164") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_whatsapp_contacts_phone_idx" ON "shop_whatsapp_contacts" ("phone_e164");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE,
  "order_id" uuid,
  "contact_id" uuid,
  "kind" text NOT NULL CHECK ("kind" IN ('NEW_ORDER', 'STATUS_UPDATE', 'NUMBER_CHECK', 'REPLY')),
  "event_type" text,
  "template" text,
  "params" jsonb,
  "body" text,
  "intended_to" text NOT NULL,
  "sent_to" text,
  "status" text NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED')),
  "meta_message_id" text,
  "error_code" text,
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "dedupe_key" text,
  "group_key" text,
  "fallback_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_meta_id_uq" ON "whatsapp_messages" ("meta_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_dedupe_uq" ON "whatsapp_messages" ("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_messages_queue_idx" ON "whatsapp_messages" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_messages_shop_idx" ON "whatsapp_messages" ("shop_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_messages_order_idx" ON "whatsapp_messages" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_messages_created_idx" ON "whatsapp_messages" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('MESSAGE', 'STATUS')),
  "from_number" text,
  "payload" jsonb,
  "result" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_webhook_events_key_uq" ON "whatsapp_webhook_events" ("event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_created_idx" ON "whatsapp_webhook_events" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_order_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL,
  "shop_id" uuid REFERENCES "shops"("id") ON DELETE CASCADE,
  "contact_id" uuid,
  "from_number" text NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('ACCEPT', 'REJECT')),
  "outcome" text NOT NULL DEFAULT 'PENDING' CHECK ("outcome" IN ('PENDING', 'DONE', 'ALREADY', 'REFUSED', 'ERROR')),
  "detail" text,
  "inbound_message_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_order_actions_order_idx" ON "whatsapp_order_actions" ("order_id", "created_at");
