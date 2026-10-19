-- batch-2026-10 0080_batch_b_dispatch (WS-B): broadcast rider offers with radius widening (F3.3.2),
-- signed single-use pickup QR + pickup scan log (F4.1.3). Additive only; all tables in the
-- customer database (with orders / delivery_orders). delivery_partners is a platform table that
-- physically lives in the customer database, so the FKs to it are same-database references.
CREATE TABLE IF NOT EXISTS "delivery_offer_broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"delivery_order_id" uuid NOT NULL REFERENCES "delivery_orders"("id") ON DELETE cascade,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"radius_m" integer NOT NULL,
	"original_partner_id" uuid REFERENCES "delivery_partners"("id") ON DELETE set null,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_step_at" timestamp with time zone NOT NULL,
	"winner_partner_id" uuid REFERENCES "delivery_partners"("id") ON DELETE set null,
	"taken_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_offer_broadcasts_open_order_unique" ON "delivery_offer_broadcasts" USING btree ("order_id") WHERE "delivery_offer_broadcasts"."status" = 'OPEN';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_offer_broadcasts_status_next_idx" ON "delivery_offer_broadcasts" USING btree ("status","next_step_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_offer_broadcasts_delivery_idx" ON "delivery_offer_broadcasts" USING btree ("delivery_order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_offer_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL REFERENCES "delivery_offer_broadcasts"("id") ON DELETE cascade,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"delivery_order_id" uuid NOT NULL REFERENCES "delivery_orders"("id") ON DELETE cascade,
	"delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE cascade,
	"radius_step" integer NOT NULL,
	"distance_to_shop_km" text,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	"outcome" text DEFAULT 'OFFERED' NOT NULL,
	"outcome_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_offer_recipients_broadcast_partner_unique" ON "delivery_offer_recipients" USING btree ("broadcast_id","delivery_partner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_offer_recipients_partner_idx" ON "delivery_offer_recipients" USING btree ("delivery_partner_id","outcome");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_pickup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"nonce_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_partner_id" uuid REFERENCES "delivery_partners"("id") ON DELETE set null,
	"consumed_delivery_order_id" uuid REFERENCES "delivery_orders"("id") ON DELETE set null,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_pickup_tokens_live_order_unique" ON "delivery_pickup_tokens" USING btree ("order_id") WHERE "delivery_pickup_tokens"."consumed_at" IS NULL AND "delivery_pickup_tokens"."revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_pickup_tokens_nonce_unique" ON "delivery_pickup_tokens" USING btree ("nonce_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_pickup_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid REFERENCES "orders"("id") ON DELETE cascade,
	"delivery_order_id" uuid REFERENCES "delivery_orders"("id") ON DELETE set null,
	"delivery_partner_id" uuid REFERENCES "delivery_partners"("id") ON DELETE set null,
	"token_id" uuid REFERENCES "delivery_pickup_tokens"("id") ON DELETE set null,
	"method" text DEFAULT 'QR' NOT NULL,
	"outcome" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"accuracy_m" integer,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_pickup_scans_delivery_idx" ON "delivery_pickup_scans" USING btree ("delivery_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_pickup_scans_order_idx" ON "delivery_pickup_scans" USING btree ("order_id");
