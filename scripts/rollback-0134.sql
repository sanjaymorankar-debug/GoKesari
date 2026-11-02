-- Rollback for 0134_billing_pos_client_ref (docs/billing). Seller database.
-- Before running: deploy the previous release's code. Then delete the 0134 row from
-- drizzle.__drizzle_migrations (both databases on the split layout).
BEGIN;
DROP INDEX IF EXISTS "acc_sales_invoices_client_ref_uq";
ALTER TABLE "acc_sales_invoices" DROP COLUMN IF EXISTS "client_ref";
COMMIT;
