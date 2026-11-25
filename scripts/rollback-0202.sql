-- Rollback for 0202_shop_gst_registrations (many GSTINs per shop, 25-Nov-2026).
-- Before running: deploy the previous release's code, then delete the 0202 row from drizzle.__drizzle_migrations.
-- Extra GSTINs added by shops are lost; every shop keeps its main GSTIN (shops.gstin), and later invoices use it.
DROP TABLE IF EXISTS "shop_gst_registrations";
