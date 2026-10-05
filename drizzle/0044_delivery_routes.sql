-- 0044 Road routing (F4): where a delivery's distance came from and its expected
-- travel times. Nullable, additive. Rollback: scripts/rollback-0044.sql
ALTER TABLE "delivery_orders" ADD COLUMN "route_source" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "leg_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "pickup_duration_seconds" integer;