-- Rollback for 0076_inventory_accounting (docs/inventory-accounting-2026-10).
-- Removes the Inventory & Accounting module's triggers, functions and tables.
-- Existing tables are untouched by 0076, so nothing else needs restoring.
-- DESTROYS the shops' books (purchases, sales invoices, ledger, GST imports):
-- take a pg_dump first. Then delete the 0076 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TRIGGER IF EXISTS inv_ledger_listing_insert ON shop_products;
DROP TRIGGER IF EXISTS inv_ledger_listing_update ON shop_products;
DROP TRIGGER IF EXISTS inv_ledger_movement ON inventory_movements;
DROP FUNCTION IF EXISTS inv_ledger_on_listing_insert();
DROP FUNCTION IF EXISTS inv_ledger_on_listing_update();
DROP FUNCTION IF EXISTS inv_ledger_on_movement();
DROP FUNCTION IF EXISTS inv_ledger_managed();
DROP TABLE IF EXISTS
  gst_reminders, gst_recon_items, gst_portal_invoices, gst_portal_imports, gst_portal_links, gst_itc_records,
  acc_change_log, acc_ledger_entries, acc_expenses, acc_payments, acc_counters, acc_sales_lines, acc_sales_invoices,
  acc_purchase_lines, acc_purchase_invoices, inv_bill_captures, acc_files, acc_parties,
  inv_supplier_item_maps, inv_unit_conversions, inv_stock_ledger, inv_batches, inv_product_settings, inv_settings
  CASCADE;
COMMIT;
