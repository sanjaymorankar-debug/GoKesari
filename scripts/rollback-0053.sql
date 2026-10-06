-- Reverses drizzle/0053_scheduled_slots.sql (GS-027). Switch the feature off
-- first (scheduledSlots.enabled = false). Orders keep delivery_slot_key, so
-- day counting is unaffected. Afterwards delete the 0053 row from
-- drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE orders DROP COLUMN IF EXISTS scheduled_slot_start, DROP COLUMN IF EXISTS scheduled_slot_end;
ALTER TABLE delivery_slot_capacities DROP COLUMN IF EXISTS scheduled_per_slot;
COMMIT;
