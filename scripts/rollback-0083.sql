-- Rollback for 0083_batch_e_finance (WS-E payouts, platform invoices, statutory rates (F10.2.4, F10.2.5)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0083 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Payout cycles/batches (with UTRs), GoKesari fee invoices and notes, and statutory-rate history are lost — export them (Admin → Payouts / Platform invoices) and keep the PDFs before rolling back.
BEGIN;
DROP TABLE IF EXISTS "document_emails" CASCADE;
DROP TABLE IF EXISTS "statutory_rates" CASCADE;
DROP TABLE IF EXISTS "platform_credit_debit_notes" CASCADE;
DROP TABLE IF EXISTS "platform_invoice_lines" CASCADE;
DROP TABLE IF EXISTS "platform_invoices" CASCADE;
DROP TABLE IF EXISTS "platform_invoice_counters" CASCADE;
DROP TABLE IF EXISTS "payout_events" CASCADE;
DROP TABLE IF EXISTS "payout_items" CASCADE;
DROP TABLE IF EXISTS "payout_batches" CASCADE;
DROP TABLE IF EXISTS "payout_cycle_lines" CASCADE;
DROP TABLE IF EXISTS "payout_cycles" CASCADE;
COMMIT;
