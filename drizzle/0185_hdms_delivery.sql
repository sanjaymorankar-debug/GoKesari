-- Hyperlocal Delivery Management System (HDMS), owner brief 23-Nov-2026; docs/hdms-2026-11/README.md.
-- Additive and safe to re-run. Nothing existing is renamed or dropped. Flag hdms_enabled (allocation engine
-- and external delivery partners) is OFF while its row is missing. The customer's checkout fee is unchanged.
-- Seller-side tables (shops, products) are not referenced by foreign key; the service checks those links.
-- Rollback: scripts/rollback-0185.sql.

-- 1. Provider master (Shadowfax, Pidge, Porter, Borzo; MOCK = in-process sandbox simulator for staging/tests).
CREATE TABLE IF NOT EXISTS "delivery_providers" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "environment" text NOT NULL DEFAULT 'SANDBOX' CHECK ("environment" IN ('SANDBOX','PRODUCTION')),
  "priority" integer NOT NULL DEFAULT 100,
  "base_url" text,
  "credentials_encrypted" text,
  "webhook_secret_encrypted" text,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "reliability_x100" integer NOT NULL DEFAULT 9000 CHECK ("reliability_x100" BETWEEN 0 AND 10000),
  "timeout_ms" integer NOT NULL DEFAULT 8000 CHECK ("timeout_ms" BETWEEN 500 AND 60000),
  "circuit_state" text NOT NULL DEFAULT 'CLOSED' CHECK ("circuit_state" IN ('CLOSED','OPEN')),
  "circuit_opened_at" timestamp with time zone,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_success_at" timestamp with time zone,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "delivery_providers" ("code","name","enabled","priority","capabilities") VALUES
  ('SHADOWFAX','Shadowfax',false,30,'{"integrated":false,"maxDistanceKm":15,"maxWeightKg":12,"refrigerated":false}'),
  ('PIDGE','Pidge',false,40,'{"integrated":false,"maxDistanceKm":15,"maxWeightKg":12,"refrigerated":false}'),
  ('PORTER','Porter',false,50,'{"integrated":false,"maxDistanceKm":25,"maxWeightKg":500,"refrigerated":false}'),
  ('BORZO','Borzo',false,50,'{"integrated":false,"maxDistanceKm":25,"maxWeightKg":20,"refrigerated":false}'),
  ('MOCK','Sandbox simulator',false,90,'{"integrated":true,"maxDistanceKm":20,"maxWeightKg":25,"refrigerated":true,"sandboxOnly":true}')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- 2. Delivery zones: circle (centre + radius) or polygon; suspended zones take no new external bookings.
CREATE TABLE IF NOT EXISTS "delivery_zones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "city" text NOT NULL,
  "center_lat" numeric(9,6) NOT NULL,
  "center_lng" numeric(9,6) NOT NULL,
  "radius_m" integer NOT NULL DEFAULT 3000 CHECK ("radius_m" BETWEEN 100 AND 50000),
  "polygon" jsonb,
  "max_delivery_km" numeric(5,2) NOT NULL DEFAULT 6 CHECK ("max_delivery_km" > 0),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','SUSPENDED')),
  "suspended_reason" text,
  "suspended_until" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Starting points only (approximate area centres, 3 km circles); operations edit them in Admin → Delivery → Zones.
INSERT INTO "delivery_zones" ("code","name","city","center_lat","center_lng") VALUES
  ('PUN-BANER','Baner','Pune',18.559000,73.786800),
  ('PUN-AUNDH','Aundh','Pune',18.558000,73.807500),
  ('PUN-BALEWADI','Balewadi','Pune',18.577000,73.779000),
  ('PUN-WAKAD','Wakad','Pune',18.597500,73.770000),
  ('PUN-HINJAWADI','Hinjawadi','Pune',18.591300,73.738900),
  ('PUN-KHARADI','Kharadi','Pune',18.551500,73.940000),
  ('PUN-VIMANNAGAR','Viman Nagar','Pune',18.567900,73.914300),
  ('PUN-KOTHRUD','Kothrud','Pune',18.507400,73.807700),
  ('PUN-DECCAN','Deccan','Pune',18.516700,73.841500),
  ('PUN-HADAPSAR','Hadapsar','Pune',18.508900,73.926000)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- 3. Pricing rules. The most specific active rule wins (zone rule before city-wide, then lowest priority number).
CREATE TABLE IF NOT EXISTS "delivery_pricing_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "zone_id" uuid REFERENCES "delivery_zones"("id") ON DELETE CASCADE,
  "active" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 100,
  "commercial_model" text NOT NULL DEFAULT 'CUSTOMER_PAYS'
    CHECK ("commercial_model" IN ('CUSTOMER_PAYS','SHOP_PAYS','SHARED','GOKESARI_SPONSORED','FREE_ABOVE_BASKET')),
  "min_fee_paise" integer NOT NULL DEFAULT 2000 CHECK ("min_fee_paise" >= 0),
  "base_km" numeric(5,2) NOT NULL DEFAULT 2 CHECK ("base_km" >= 0),
  "per_km_paise" integer NOT NULL DEFAULT 800 CHECK ("per_km_paise" >= 0),
  "free_weight_grams" integer NOT NULL DEFAULT 5000 CHECK ("free_weight_grams" >= 0),
  "per_kg_paise" integer NOT NULL DEFAULT 500 CHECK ("per_kg_paise" >= 0),
  "express_surcharge_paise" integer NOT NULL DEFAULT 1000 CHECK ("express_surcharge_paise" >= 0),
  "peak_surcharge_paise" integer NOT NULL DEFAULT 1000 CHECK ("peak_surcharge_paise" >= 0),
  "peak_windows" jsonb NOT NULL DEFAULT '[{"from":"08:00","to":"10:00"},{"from":"18:00","to":"21:00"}]'::jsonb,
  "free_above_paise" integer CHECK ("free_above_paise" IS NULL OR "free_above_paise" >= 0),
  "shop_share_percent" integer NOT NULL DEFAULT 50 CHECK ("shop_share_percent" BETWEEN 0 AND 100),
  "gokesari_subsidy_paise" integer NOT NULL DEFAULT 0 CHECK ("gokesari_subsidy_paise" >= 0),
  "promo_discount_paise" integer NOT NULL DEFAULT 0 CHECK ("promo_discount_paise" >= 0),
  "max_fee_paise" integer CHECK ("max_fee_paise" IS NULL OR "max_fee_paise" >= 0),
  "valid_from" timestamp with time zone,
  "valid_until" timestamp with time zone,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "delivery_pricing_rules" ("name","priority","commercial_model","free_above_paise")
SELECT 'Pune default', 1000, 'FREE_ABOVE_BASKET', 49900
WHERE NOT EXISTS (SELECT 1 FROM "delivery_pricing_rules");
--> statement-breakpoint

-- 4. Bookings: one row per delivery attempt by any channel. At most one live booking per order.
CREATE TABLE IF NOT EXISTS "delivery_bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "shop_id" uuid NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('SHOP_RIDER','GOKESARI_RIDER','EXTERNAL')),
  "provider_code" text REFERENCES "delivery_providers"("code"),
  "shop_delivery_staff_id" uuid,
  "zone_id" uuid REFERENCES "delivery_zones"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'CREATED' CHECK ("status" IN
    ('CREATED','SEARCHING','ASSIGNED','AT_PICKUP','PICKED_UP','IN_TRANSIT','DELIVERED','FAILED','RETURNING','RETURNED','CANCELLED')),
  "idempotency_key" text NOT NULL UNIQUE,
  "external_ref" text,
  "tracking_url" text,
  "rider_name" text,
  "rider_phone_masked" text,
  "rider_lat" numeric(9,6),
  "rider_lng" numeric(9,6),
  "rider_location_at" timestamp with time zone,
  "eta_at" timestamp with time zone,
  "distance_m" integer,
  "quoted_fee_paise" integer,
  "final_fee_paise" integer,
  "pricing" jsonb,
  "cancel_reason" text,
  "cancelled_by" text CHECK ("cancelled_by" IS NULL OR "cancelled_by" IN ('CUSTOMER','SHOP','PROVIDER','ADMIN','SYSTEM')),
  "failure_reason" text,
  "last_polled_at" timestamp with time zone,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "terminal_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_bookings_one_live_per_order"
  ON "delivery_bookings" ("order_id") WHERE "status" NOT IN ('DELIVERED','FAILED','RETURNED','CANCELLED');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_bookings_provider_ref_uq"
  ON "delivery_bookings" ("provider_code","external_ref") WHERE "external_ref" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_bookings_status_idx" ON "delivery_bookings" ("status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_bookings_shop_idx" ON "delivery_bookings" ("shop_id","created_at");
--> statement-breakpoint

-- 5. Status history of a booking (provider webhooks, polling, shop, admin, system).
CREATE TABLE IF NOT EXISTS "delivery_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "booking_id" uuid NOT NULL REFERENCES "delivery_bookings"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('WEBHOOK','POLL','SHOP','ADMIN','SYSTEM','CUSTOMER')),
  "note" text,
  "lat" numeric(9,6),
  "lng" numeric(9,6),
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_events_booking_idx" ON "delivery_events" ("booking_id","occurred_at");
--> statement-breakpoint

-- 6. Allocation decisions and the quotes behind them.
CREATE TABLE IF NOT EXISTS "delivery_allocation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,
  "outcome" text NOT NULL CHECK ("outcome" IN ('BOOKED','INTERNAL','NO_CANDIDATE','SKIPPED','ERROR')),
  "chosen_channel" text,
  "chosen_provider" text,
  "booking_id" uuid REFERENCES "delivery_bookings"("id") ON DELETE SET NULL,
  "distance_m" integer,
  "requirements" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "detail" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_allocation_runs_order_idx" ON "delivery_allocation_runs" ("order_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "delivery_allocation_runs"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "provider_code" text,
  "serviceable" boolean NOT NULL,
  "fee_paise" integer,
  "eta_minutes" integer,
  "reliability_x100" integer,
  "score" numeric(8,4),
  "rejected_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_quotes_run_idx" ON "delivery_quotes" ("run_id");
--> statement-breakpoint

-- 7. Webhook log (one row per provider event id: a redelivery changes nothing) and outbound API log.
CREATE TABLE IF NOT EXISTS "delivery_webhook_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" text NOT NULL,
  "event_id" text NOT NULL,
  "signature_valid" boolean NOT NULL,
  "booking_id" uuid REFERENCES "delivery_bookings"("id") ON DELETE SET NULL,
  "result" text NOT NULL,
  "payload" jsonb,
  "received_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_webhook_logs_event_uq" ON "delivery_webhook_logs" ("provider_code","event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_webhook_logs_received_idx" ON "delivery_webhook_logs" ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_api_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" text NOT NULL,
  "operation" text NOT NULL,
  "ok" boolean NOT NULL,
  "http_status" integer,
  "duration_ms" integer NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "error" text,
  "booking_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_api_logs_provider_idx" ON "delivery_api_logs" ("provider_code","created_at");
--> statement-breakpoint

-- 8. Provider settlements and reconciliation against the provider's invoice.
CREATE TABLE IF NOT EXISTS "delivery_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" text NOT NULL REFERENCES "delivery_providers"("code"),
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','RECONCILED','DISPUTED','PAID')),
  "booking_count" integer NOT NULL DEFAULT 0,
  "expected_paise" bigint NOT NULL DEFAULT 0,
  "invoiced_paise" bigint,
  "difference_paise" bigint,
  "invoice_ref" text,
  "paid_ref" text,
  "notes" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_settlements_period_uq" ON "delivery_settlements" ("provider_code","period_start","period_end");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_reconciliation_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "settlement_id" uuid NOT NULL REFERENCES "delivery_settlements"("id") ON DELETE CASCADE,
  "booking_id" uuid REFERENCES "delivery_bookings"("id") ON DELETE SET NULL,
  "external_ref" text,
  "expected_paise" integer,
  "invoiced_paise" integer,
  "result" text NOT NULL CHECK ("result" IN ('MATCHED','AMOUNT_MISMATCH','NOT_IN_INVOICE','UNKNOWN_BOOKING')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_reconciliation_lines_settlement_idx" ON "delivery_reconciliation_lines" ("settlement_id");
--> statement-breakpoint

-- 9. Product delivery attributes (one optional row per product; no row = ordinary item).
CREATE TABLE IF NOT EXISTS "product_delivery_attributes" (
  "product_id" uuid PRIMARY KEY,
  "perishable" boolean NOT NULL DEFAULT false,
  "fragile" boolean NOT NULL DEFAULT false,
  "temperature_sensitive" boolean NOT NULL DEFAULT false,
  "refrigeration_required" boolean NOT NULL DEFAULT false,
  "max_delivery_minutes" integer CHECK ("max_delivery_minutes" IS NULL OR "max_delivery_minutes" BETWEEN 5 AND 1440),
  "weight_grams" integer CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0),
  "length_mm" integer,
  "width_mm" integer,
  "height_mm" integer,
  "packaging_note" text,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- 10. Shop-owned riders (existing shop_delivery_staff): availability, vehicle and ID proof. Additive columns.
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "is_available" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "vehicle_type" text;
--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "id_document_type" text;
--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "id_document_last4" text;
--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "id_document_image_id" uuid;
--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD COLUMN IF NOT EXISTS "kyc_status" text NOT NULL DEFAULT 'NOT_SUBMITTED';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shop_delivery_staff" ADD CONSTRAINT "shop_delivery_staff_kyc_status_chk"
    CHECK ("kyc_status" IN ('NOT_SUBMITTED','SUBMITTED','VERIFIED','REJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
