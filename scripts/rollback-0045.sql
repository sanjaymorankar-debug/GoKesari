-- Reverses drizzle/0045_delivery_slots.sql. Afterwards delete the 0045 row from drizzle.__drizzle_migrations.
DROP INDEX IF EXISTS "orders_delivery_slot_idx";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "delivery_slot_key";
DROP TABLE IF EXISTS "delivery_slot_capacities";
