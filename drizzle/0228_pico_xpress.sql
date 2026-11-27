-- Pico Xpress, the "gokesari.com delivery partner" (docs/pico-xpress-2026-11). Additive only.
-- A Pico shipment is an HDMS booking (delivery_bookings, provider PICO); these tables hold Pico's own data.
-- Rollback: scripts/rollback-0228-pico-xpress.sql.

-- 1. AWB numbers fetched in bulk from Pico (doc page 2). Never reused, not even after a cancel.
CREATE TABLE IF NOT EXISTS "delivery_awb_pool" (
  "awb_number" text PRIMARY KEY,
  "env" text NOT NULL CHECK ("env" IN ('STAGING','PRODUCTION')),
  "status" text NOT NULL DEFAULT 'AVAILABLE' CHECK ("status" IN ('AVAILABLE','ALLOCATED','USED','CANCELLED')),
  "order_id" uuid,
  "shipment_id" uuid,
  "box_no" integer,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now(),
  "allocated_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_awb_pool_available_idx" ON "delivery_awb_pool" ("env", "status", "fetched_at");
--> statement-breakpoint

-- 2. The manifest sent to Pico and Pico's view of the shipment (one row per booking).
CREATE TABLE IF NOT EXISTS "delivery_shipments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "partner_code" text NOT NULL DEFAULT 'PICO',
  "env" text NOT NULL CHECK ("env" IN ('STAGING','PRODUCTION')),
  "pico_order_id" text NOT NULL,
  "awb_number" text NOT NULL,
  "child_awbs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payment_type" text NOT NULL CHECK ("payment_type" IN ('COD','PREPAID')),
  "collectible_paise" bigint NOT NULL DEFAULT 0,
  "goods_total_paise" bigint NOT NULL,
  "num_boxes" integer NOT NULL DEFAULT 1 CHECK ("num_boxes" BETWEEN 1 AND 20),
  "dead_weight_grams" integer NOT NULL CHECK ("dead_weight_grams" > 0),
  "pickup_type" text NOT NULL,
  "eway_bill_no" text,
  "code_nonce" text NOT NULL,
  "status" text NOT NULL DEFAULT 'CREATED',
  "partner_name" text,
  "partner_phone" text,
  "tracking_url" text,
  "pickup_eta_min" integer,
  "delivery_eta_min" integer,
  "eta" timestamp with time zone,
  "ata" timestamp with time zone,
  "etd" timestamp with time zone,
  "atd" timestamp with time zone,
  "last_lat" numeric(9,6),
  "last_lng" numeric(9,6),
  "last_location_at" timestamp with time zone,
  "last_event_at" timestamp with time zone,
  "last_reason" text,
  "cancel_reason" text,
  "cancelled_by" text,
  "dispute_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- 0 collectible means PREPAID, more than 0 means COD (Pico's rule).
  CONSTRAINT "delivery_shipments_payment" CHECK (("payment_type" = 'PREPAID' AND "collectible_paise" = 0) OR ("payment_type" = 'COD' AND "collectible_paise" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_shipments_booking_uq" ON "delivery_shipments" ("booking_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_shipments_awb_uq" ON "delivery_shipments" ("awb_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_shipments_pico_order_uq" ON "delivery_shipments" ("env", "pico_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_shipments_order_idx" ON "delivery_shipments" ("order_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_shipments_status_idx" ON "delivery_shipments" ("status", "updated_at");
--> statement-breakpoint

-- 3. Every status Pico reported, once: duplicates of AWB + status + time are dropped (webhook redeliveries, pulls).
CREATE TABLE IF NOT EXISTS "delivery_shipment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shipment_id" uuid,
  "awb_number" text NOT NULL,
  "status" text NOT NULL,
  "event_ts" timestamp with time zone NOT NULL,
  "lat" numeric(9,6),
  "lng" numeric(9,6),
  "reason" text,
  "source" text NOT NULL CHECK ("source" IN ('WEBHOOK','PULL','SYSTEM')),
  "raw_payload" jsonb,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_shipment_events_dedupe_uq" ON "delivery_shipment_events" ("awb_number", "status", "event_ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_shipment_events_shipment_idx" ON "delivery_shipment_events" ("shipment_id", "event_ts");
--> statement-breakpoint

-- 4. Live rider positions (paid add-on; flag pico_live_location_enabled).
CREATE TABLE IF NOT EXISTS "delivery_location_pings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "awb_number" text NOT NULL,
  "lat" numeric(9,6) NOT NULL,
  "lng" numeric(9,6) NOT NULL,
  "pickup_eta_min" integer,
  "delivery_eta_min" integer,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_location_pings_awb_idx" ON "delivery_location_pings" ("awb_number", "received_at");
--> statement-breakpoint

-- 5. Calls to Pico, with phones, OTPs, names, addresses and keys masked before they are written.
CREATE TABLE IF NOT EXISTS "delivery_partner_api_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partner_code" text NOT NULL DEFAULT 'PICO',
  "env" text,
  "endpoint" text NOT NULL,
  "method" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "http_status" integer,
  "px_code" text,
  "response_message" text,
  "ok" text NOT NULL CHECK ("ok" IN ('Y','N')),
  "latency_ms" integer NOT NULL,
  "request_body" jsonb,
  "response_body" jsonb,
  "error" text,
  "order_id" uuid,
  "shipment_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_partner_api_logs_created_idx" ON "delivery_partner_api_logs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_partner_api_logs_order_idx" ON "delivery_partner_api_logs" ("order_id");
--> statement-breakpoint

-- 6. A GoKesari-partner plan booked with Pico: the GoKesari rider search never starts for it.
ALTER TABLE "order_fulfilment_arrangements" ADD COLUMN IF NOT EXISTS "external_partner" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_external_partner"
    CHECK ("external_partner" IS NULL OR ("external_partner" = 'PICO' AND "option" = 'GOKESARI_PARTNER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- 7. The provider row (HDMS): stays disabled for the generic allocation engine; Pico is booked from the shop's choice.
INSERT INTO "delivery_providers" ("code","name","enabled","environment","priority","base_url","capabilities","timeout_ms")
VALUES ('PICO','Pico Xpress',false,
  CASE WHEN current_database() = 'gokesari' THEN 'PRODUCTION' ELSE 'SANDBOX' END,
  20,
  CASE WHEN current_database() = 'gokesari' THEN 'https://api.picoxpress.com' ELSE 'https://dev-api.picoxpress.com' END,
  '{"integrated":true,"maxDistanceKm":15,"maxWeightKg":20,"refrigerated":false}', 10000)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- 8. Flags: Pico ON on the staging database, OFF on production until its production test; live location OFF on both.
INSERT INTO "feature_flags" ("key", "enabled") VALUES
  ('delivery_partner_picoxpress_enabled', current_database() = 'gokesari_test'),
  ('pico_live_location_enabled', false)
ON CONFLICT DO NOTHING;
