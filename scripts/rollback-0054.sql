-- Reverses drizzle/0054_delivery_trips.sql (GA-005). Switch batching off
-- first (batching.enabled = false) and let open trips finish; each delivery
-- row stays intact, only the grouping is dropped. Afterwards delete the 0054
-- row from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE delivery_orders DROP COLUMN IF EXISTS trip_id;
DROP TABLE IF EXISTS delivery_trips;
COMMIT;
