-- Rollback for 0076_product_bulk_import (docs/product-import-2026-10).
-- Run only after the previous code is live, then delete the 0076 row from
-- drizzle.__drizzle_migrations (the newest row). Back up first: import history,
-- listing SKUs / per-shop MRPs and imported attributes are lost. Products and
-- listings an import created stay (they are ordinary products / shop_products
-- rows), and so do their stock movements; only the two new ledger columns go.
DROP INDEX IF EXISTS "inventory_movements_import_job_idx";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "import_job_id";
ALTER TABLE "inventory_movements" DROP COLUMN IF EXISTS "source";
DROP TABLE IF EXISTS "product_attributes";
DROP TABLE IF EXISTS "shop_listing_details";
DROP TABLE IF EXISTS "product_import_rows";
DROP TABLE IF EXISTS "product_import_jobs";
DROP SEQUENCE IF EXISTS "product_import_sku_seq";
