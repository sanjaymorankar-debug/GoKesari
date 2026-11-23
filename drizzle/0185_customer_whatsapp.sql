-- Customer WhatsApp (owner brief 23-Nov-2026, module 2; docs/customer-whatsapp-2026-11/README.md):
-- order / payment / delivery / refund / renewal updates to customers on WhatsApp (Meta Cloud API templates,
-- only with the customer's WhatsApp consent), and shopping by chat (search → pick → quantity → cart → a signed
-- checkout link that loads the cart on the website). Reuses the shop-order outbox (whatsapp_messages, 0169).
--
-- * consent_type + WHATSAPP_NOTIFICATIONS; user_consents.source (PROFILE, WHATSAPP_KEYWORD, ...).
-- * whatsapp_messages: kinds CUSTOMER_NOTIFICATION / CUSTOMER_REPLY and a user_id column (no foreign key).
-- * whatsapp_customer_sessions: one chat session per phone (state, cart jsonb, expiry, rate-limit window).
-- * whatsapp_cart_links: the cart snapshot behind a signed, short-lived, single-use checkout link.
-- * feature flag whatsapp_customer_enabled (OFF). Rule whatsappCustomer (code default enabled:false).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0185.sql (enum values cannot be dropped; unused, inert).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'consent_type' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."consent_type" ADD VALUE IF NOT EXISTS ''WHATSAPP_NOTIFICATIONS''';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "user_consents" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD COLUMN IF NOT EXISTS "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" DROP CONSTRAINT IF EXISTS "whatsapp_messages_kind_check";
--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_kind_check"
  CHECK ("kind" IN ('NEW_ORDER', 'STATUS_UPDATE', 'NUMBER_CHECK', 'REPLY', 'CUSTOMER_NOTIFICATION', 'CUSTOMER_REPLY'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_messages_user_idx" ON "whatsapp_messages" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_customer_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "phone_e164" text NOT NULL,
  "user_id" uuid,
  "state" text NOT NULL DEFAULT 'IDLE' CHECK ("state" IN ('IDLE', 'AWAIT_PIN', 'PICK', 'QTY')),
  "context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "cart" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pincode" text,
  "opted_out_at" timestamp with time zone,
  "window_started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "window_count" integer NOT NULL DEFAULT 0,
  "last_inbound_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_customer_sessions_phone_uq" ON "whatsapp_customer_sessions" ("phone_e164");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_customer_sessions_expires_idx" ON "whatsapp_customer_sessions" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_cart_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid,
  "phone_e164" text NOT NULL,
  "user_id" uuid,
  "lines" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_cart_links_phone_idx" ON "whatsapp_cart_links" ("phone_e164", "created_at");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('whatsapp_customer_enabled', false) ON CONFLICT DO NOTHING;
