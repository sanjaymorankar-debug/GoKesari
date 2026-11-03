-- Rollback for 0143_counter_bill_kind (docs/billing). Seller database.
-- Before running: deploy the previous release's code. Then delete the 0143 row from
-- drizzle.__drizzle_migrations (both databases on the split layout).
BEGIN;
ALTER TABLE "acc_sales_invoices" DROP CONSTRAINT IF EXISTS "acc_sales_invoices_kind";
ALTER TABLE "acc_sales_invoices" DROP COLUMN IF EXISTS "kind";
COMMIT;
