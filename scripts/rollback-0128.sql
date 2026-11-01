-- Rollback for 0128_billing_shop_documents (docs/billing). Seller database.
-- Before running: switch billing_v2 off and deploy the previous release's code. Export first:
--   \copy acc_documents TO 'acc_documents.csv' CSV HEADER   (GST records: keep 8 years)
-- Then delete the 0128 row from drizzle.__drizzle_migrations (both databases on the split layout).
BEGIN;
DROP TRIGGER IF EXISTS "acc_documents_immutable" ON "acc_documents";
DROP FUNCTION IF EXISTS acc_document_immutable();
DROP TABLE IF EXISTS "acc_documents";
ALTER TABLE "inv_settings" DROP COLUMN IF EXISTS "upi_vpa";
COMMIT;
