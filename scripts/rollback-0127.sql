-- Rollback for 0127_billing_documents (docs/billing). Core database.
-- Before running: switch billing_v2 off and deploy the previous release's code. Export first:
--   \copy platform_delivery_invoices TO 'platform_delivery_invoices.csv' CSV HEADER   (GST records: keep 8 years)
-- Cancellation marks on tax_invoices are lost; export them if any:
--   SELECT id, invoice_number, status, cancelled_at, cancel_reason FROM tax_invoices WHERE status = 'CANCELLED';
-- Then delete the 0127 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TRIGGER IF EXISTS "platform_delivery_invoices_immutable" ON "platform_delivery_invoices";
DROP TRIGGER IF EXISTS "tax_invoices_immutable" ON "tax_invoices";
DROP FUNCTION IF EXISTS gst_document_immutable();
DROP TABLE IF EXISTS "platform_delivery_invoice_counters";
DROP TABLE IF EXISTS "platform_delivery_invoices";
ALTER TABLE "tax_invoices" DROP CONSTRAINT IF EXISTS "tax_invoices_status_check";
ALTER TABLE "tax_invoices" DROP COLUMN IF EXISTS "cancel_reason";
ALTER TABLE "tax_invoices" DROP COLUMN IF EXISTS "cancelled_by";
ALTER TABLE "tax_invoices" DROP COLUMN IF EXISTS "cancelled_at";
ALTER TABLE "tax_invoices" DROP COLUMN IF EXISTS "status";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_buyer_gstin_status_check";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "buyer_gstin_status";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "buyer_legal_name";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "buyer_gstin";
COMMIT;
