-- split: core
-- Dealer programme step 7 (docs/dealer-programme, GKS-SP-001): the paid Support Services page —
-- general support, product upload and price update — with admin-set charges (versioned), a
-- free monthly quota, payment from the shop wallet or online, and a help-desk ticket per paid
-- request. Core database: requests join support tickets, payment intents and users; shop ids
-- point at the seller database and carry no foreign key.
-- The only change to an existing table: payment_intents may now carry purpose SUPPORT_SERVICE.
-- ADDITIVE ONLY; idempotent.
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE', 'SUPPORT_SERVICE'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_service_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"unit_label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "support_service_types_status" CHECK ("status" in ('ACTIVE', 'INACTIVE'))
);--> statement-breakpoint
INSERT INTO "support_service_types" ("key", "label", "description", "unit_label", "sort_order") VALUES
	('GENERAL', 'General support', 'Help with your account, registration, orders, payments or a technical problem.', NULL, 1),
	('PRODUCT_UPLOAD', 'Product upload', 'Our team adds your products — names, photos and descriptions — from your list or photos.', 'products', 2),
	('PRICE_UPDATE', 'Price update', 'Our team updates your prices, MRP overrides, discounts and schemes from your price list.', 'products', 3)
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_service_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_key" text NOT NULL REFERENCES "support_service_types"("key") ON DELETE RESTRICT,
	"version" integer NOT NULL,
	"charge_model" text NOT NULL,
	"amount_paise" integer DEFAULT 0 NOT NULL,
	"batch_size" integer,
	"gst_applicable" boolean DEFAULT true NOT NULL,
	"gst_rate_bp" integer DEFAULT 1800 NOT NULL,
	"free_quota_per_month" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"change_reason" text NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_service_charges_model" CHECK ("charge_model" in ('FREE', 'PER_REQUEST', 'PER_ITEM', 'PER_BATCH')),
	CONSTRAINT "support_service_charges_amount" CHECK ("amount_paise" >= 0 AND ("charge_model" <> 'FREE' OR "amount_paise" = 0)),
	CONSTRAINT "support_service_charges_batch" CHECK (("charge_model" = 'PER_BATCH') = ("batch_size" IS NOT NULL) AND ("batch_size" IS NULL OR "batch_size" > 0)),
	CONSTRAINT "support_service_charges_gst" CHECK ("gst_rate_bp" BETWEEN 0 AND 2800),
	CONSTRAINT "support_service_charges_quota" CHECK ("free_quota_per_month" >= 0),
	CONSTRAINT "support_service_charges_status" CHECK ("status" in ('ACTIVE', 'SUPERSEDED')),
	CONSTRAINT "support_service_charges_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_service_charges_version_unique" ON "support_service_charges" ("service_key", "version");--> statement-breakpoint
-- Starting values (the admin changes them): general support free; uploads and price updates per 50 products.
INSERT INTO "support_service_charges" ("service_key", "version", "charge_model", "amount_paise", "batch_size", "gst_applicable", "free_quota_per_month", "effective_from", "change_reason")
SELECT c.k, 1, c.model, c.amount, c.batch, c.gst, c.quota, DATE '2026-10-28', 'starting value (dealer programme step 7)'
  FROM (VALUES ('GENERAL', 'FREE', 0, NULL::integer, false, 0),
               ('PRODUCT_UPLOAD', 'PER_BATCH', 49900, 50, true, 0),
               ('PRICE_UPDATE', 'PER_BATCH', 19900, 50, true, 1)) AS c(k, model, amount, batch, gst, quota)
 WHERE NOT EXISTS (SELECT 1 FROM "support_service_charges" x WHERE x."service_key" = c.k);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_service_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"refund_percent_before_work" integer DEFAULT 100 NOT NULL,
	"free_for_managed_billing" boolean DEFAULT true NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_service_settings_single" CHECK ("id" = 'default'),
	CONSTRAINT "support_service_settings_refund" CHECK ("refund_percent_before_work" BETWEEN 0 AND 100)
);--> statement-breakpoint
INSERT INTO "support_service_settings" ("id") VALUES ('default') ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_number" text NOT NULL,
	"shop_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
	"dealer_id" uuid,
	"service_key" text NOT NULL REFERENCES "support_service_types"("key") ON DELETE RESTRICT,
	"charge_id" uuid NOT NULL REFERENCES "support_service_charges"("id") ON DELETE RESTRICT,
	"quantity" integer DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"base_paise" integer DEFAULT 0 NOT NULL,
	"gst_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"free_reason" text,
	"status" text DEFAULT 'AWAITING_PAYMENT' NOT NULL,
	"payment_method" text,
	"payment_intent_id" uuid REFERENCES "payment_intents"("id") ON DELETE SET NULL,
	"wallet_reference" text,
	"ticket_id" uuid REFERENCES "support_tickets"("id") ON DELETE SET NULL,
	"refund_paise" integer DEFAULT 0 NOT NULL,
	"refund_reason" text,
	"refunded_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_service_requests_status" CHECK ("status" in ('AWAITING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED')),
	CONSTRAINT "support_service_requests_method" CHECK ("payment_method" IS NULL OR "payment_method" in ('WALLET', 'ONLINE', 'FREE')),
	CONSTRAINT "support_service_requests_free_reason" CHECK ("free_reason" IS NULL OR "free_reason" in ('FREE_SERVICE', 'MONTHLY_QUOTA', 'MANAGED_BILLING')),
	CONSTRAINT "support_service_requests_quantity" CHECK ("quantity" BETWEEN 1 AND 100000),
	CONSTRAINT "support_service_requests_amounts" CHECK ("base_paise" >= 0 AND "gst_paise" >= 0 AND "total_paise" = "base_paise" + "gst_paise" AND "refund_paise" BETWEEN 0 AND "total_paise")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_service_requests_receipt_unique" ON "support_service_requests" ("receipt_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_service_requests_shop_idx" ON "support_service_requests" ("shop_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_service_requests_status_idx" ON "support_service_requests" ("status", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_service_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "support_service_requests"("id") ON DELETE CASCADE,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_service_files_size" CHECK ("size_bytes" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_service_files_request_idx" ON "support_service_files" ("request_id");
