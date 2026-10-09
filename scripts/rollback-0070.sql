-- Reverses drizzle/0070_gst_compliance.sql (Module 2: GST compliance).
-- Deploy the previous build first. Back up first.
-- Credit notes, e-invoices (IRNs) and e-way bills are tax documents: the
-- block below refuses to run while any exist. Export them first
-- (shop GSTR-1 export / database dump) and decide with the CA.
-- Invoice numbers go back to being unique across all shops: this fails if
-- 16-character (GST16) numbers repeat across shops — switch numbering back to
-- LEGACY and resolve those first.
-- Afterwards delete the 0070 row from drizzle.__drizzle_migrations.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_notes) OR EXISTS (SELECT 1 FROM einvoice_records) OR EXISTS (SELECT 1 FROM eway_bills) THEN
    RAISE EXCEPTION 'Credit notes, e-invoices or e-way bills exist: keep them (see the comment at the top).';
  END IF;
END $$;
DROP TABLE IF EXISTS gst_return_exports;
DROP TABLE IF EXISTS gstin_lookups;
DROP TABLE IF EXISTS eway_bills;
DROP TABLE IF EXISTS einvoice_records;
DROP TABLE IF EXISTS credit_note_counters;
DROP TABLE IF EXISTS credit_notes;
DROP TABLE IF EXISTS hsn_tax_rates;
DROP TABLE IF EXISTS gst_rules;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_turnover_declared_by_users_id_fk;
ALTER TABLE shops DROP COLUMN IF EXISTS turnover_declared_by;
ALTER TABLE shops DROP COLUMN IF EXISTS turnover_declared_at;
ALTER TABLE shops DROP COLUMN IF EXISTS declared_turnover_band;
ALTER TABLE shops DROP COLUMN IF EXISTS einvoice_applicable;
DROP INDEX IF EXISTS tax_invoices_shop_number_unique;
CREATE UNIQUE INDEX IF NOT EXISTS tax_invoices_number_unique ON tax_invoices (invoice_number);
COMMIT;
