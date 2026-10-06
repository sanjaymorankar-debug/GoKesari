-- 0045 Delivery slot capacity (F5): per-shop / per-area order limits per slot, and
-- the slot each order was booked into. New table + nullable column; existing
-- orders keep NULL (not counted). Rollback: scripts/rollback-0045.sql
CREATE TABLE "delivery_slot_capacities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"pincode" text,
	"express_per_hour" integer,
	"standard_per_hour" integer,
	"scheduled_per_day" integer,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_slot_capacities_one_scope" CHECK (("delivery_slot_capacities"."shop_id" IS NULL) <> ("delivery_slot_capacities"."pincode" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_slot_key" text;--> statement-breakpoint
ALTER TABLE "delivery_slot_capacities" ADD CONSTRAINT "delivery_slot_capacities_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_slot_capacities" ADD CONSTRAINT "delivery_slot_capacities_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_slot_capacities_shop_uq" ON "delivery_slot_capacities" USING btree ("shop_id") WHERE "delivery_slot_capacities"."shop_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_slot_capacities_pincode_uq" ON "delivery_slot_capacities" USING btree ("pincode") WHERE "delivery_slot_capacities"."pincode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_delivery_slot_idx" ON "orders" USING btree ("shop_id","delivery_window","delivery_slot_key");