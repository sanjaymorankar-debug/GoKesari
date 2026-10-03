CREATE TYPE "public"."delivery_order_status" AS ENUM('OFFERED', 'ACCEPTED', 'REJECTED', 'PICKED_UP', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."delivery_window" AS ENUM('EXPRESS_30', 'STANDARD_60', 'SCHEDULED');--> statement-breakpoint
CREATE TABLE "delivery_earnings_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_fee_paise" bigint NOT NULL,
	"per_km_fee_paise" bigint NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_earnings_config_non_negative" CHECK ("delivery_earnings_config"."base_fee_paise" >= 0 AND "delivery_earnings_config"."per_km_fee_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"status" "delivery_order_status" DEFAULT 'OFFERED' NOT NULL,
	"distance_km" text,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_partner_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"delivery_order_id" uuid NOT NULL,
	"base_paise" bigint NOT NULL,
	"distance_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "is_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "last_location_latitude" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "last_location_longitude" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "last_location_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_window" "delivery_window";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promised_by_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "preparation_time_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_earnings_config" ADD CONSTRAINT "delivery_earnings_config_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD CONSTRAINT "delivery_partner_earnings_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD CONSTRAINT "delivery_partner_earnings_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_orders_order_id_unique" ON "delivery_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "delivery_orders_partner_idx" ON "delivery_orders" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE INDEX "delivery_orders_status_idx" ON "delivery_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_partner_earnings_order_unique" ON "delivery_partner_earnings" USING btree ("delivery_order_id");--> statement-breakpoint
CREATE INDEX "delivery_partner_earnings_partner_idx" ON "delivery_partner_earnings" USING btree ("delivery_partner_id");