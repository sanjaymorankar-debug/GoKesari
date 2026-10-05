-- Reverses drizzle/0046_order_groups.sql. Afterwards delete the 0046 row from drizzle.__drizzle_migrations.
DROP INDEX IF EXISTS "orders_order_group_idx";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_order_group_id_order_groups_id_fk";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "order_group_id";
DROP TABLE IF EXISTS "order_groups";
