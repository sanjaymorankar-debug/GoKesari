-- Reverses drizzle/0055_order_completion.sql (NEW-007). Switch shopAcceptance,
-- deliveryProof and invoicing off first. Back up first: this drops issued
-- invoices and the proof links (the photos stay in stored_images; delete
-- purpose = 'DELIVERY_PROOF' rows separately if they must go too).
-- Afterwards delete the 0055 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS invoice_counters;
DROP TABLE IF EXISTS tax_invoices;
DROP TABLE IF EXISTS delivery_proofs;
DROP TABLE IF EXISTS shop_sla_events;
ALTER TABLE orders DROP COLUMN IF EXISTS accept_by_at, DROP COLUMN IF EXISTS accept_reminder_sent_at;
COMMIT;
