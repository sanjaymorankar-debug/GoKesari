-- Rollback for 0135_billing_restaurant_s95 (docs/billing §5.3). Core (customer) database.
-- Before running: deploy the previous release's code. Then delete the 0135 row from
-- drizzle.__drizzle_migrations. Restaurant s.9(5) invoices already issued are tax documents:
-- export them first (Admin → Compliance, GSTR-1) — this script removes them.
BEGIN;
ALTER TABLE "platform_delivery_invoices" DISABLE TRIGGER "platform_delivery_invoices_immutable";
DELETE FROM "platform_delivery_invoices" WHERE "kind" = 'RESTAURANT';
ALTER TABLE "platform_delivery_invoices" ENABLE TRIGGER "platform_delivery_invoices_immutable";
CREATE UNIQUE INDEX IF NOT EXISTS "platform_delivery_invoices_order_uq" ON "platform_delivery_invoices" USING btree ("order_id");
DROP INDEX IF EXISTS "platform_delivery_invoices_order_kind_uq";
ALTER TABLE "platform_delivery_invoices" DROP CONSTRAINT IF EXISTS "platform_delivery_invoices_kind_check";
ALTER TABLE "platform_delivery_invoices" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "order_money_flows" DROP CONSTRAINT IF EXISTS "order_money_flows_food_gst_liable_check";
ALTER TABLE "order_money_flows" DROP COLUMN IF EXISTS "food_gst_liable";
ALTER TABLE "order_money_flows" DROP COLUMN IF EXISTS "food_gst_rate_bp";
ALTER TABLE "order_money_flows" DROP COLUMN IF EXISTS "food_gst_paise";
COMMIT;
