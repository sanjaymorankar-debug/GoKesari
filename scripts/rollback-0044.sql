-- Reverses drizzle/0044_delivery_routes.sql. Afterwards delete the 0044 row from drizzle.__drizzle_migrations.
ALTER TABLE "delivery_orders" DROP COLUMN IF EXISTS "pickup_duration_seconds", DROP COLUMN IF EXISTS "leg_duration_seconds", DROP COLUMN IF EXISTS "route_source";
