-- Rollback for 0184_order_tax_snapshot. Before running: deploy the previous release's code (it never reads
-- these columns); the recorded per-line GST split is lost. Then delete the 0184 row from drizzle.__drizzle_migrations.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "tax_included_paise";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "tax_paise";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "taxable_paise";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "cess_bp";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "gst_rate_bp";
ALTER TABLE "order_items" DROP COLUMN IF EXISTS "hsn_code";
