-- 0054 GA-005: rider batching. A trip groups the deliveries one rider carries
-- together (delivery_orders.trip_id). Each delivery keeps its own row, status
-- and handover codes; the stop sequence is derived on read. trip_id is null
-- for every existing delivery and for any order carried alone, so nothing
-- changes unless the batching rule is switched on (off by default).
-- Rollback: scripts/rollback-0054.sql
CREATE TABLE "delivery_trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "trip_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_trips" ADD CONSTRAINT "delivery_trips_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_trips_partner_idx" ON "delivery_trips" USING btree ("delivery_partner_id");--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_trip_id_delivery_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."delivery_trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_orders_trip_idx" ON "delivery_orders" USING btree ("trip_id");
