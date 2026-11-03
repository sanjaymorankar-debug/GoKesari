-- Rollback for 0141_commission_tds (gap report Part D). Core database. Before running: switch rule
-- dealerPayoutTds off and deploy the previous release's code. Export the four tables first — challans
-- and Form 16A are tax records. Then delete the 0141 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "commission_tds_forms16a";
DROP TABLE IF EXISTS "commission_tds_challans";
DROP TABLE IF EXISTS "commission_tds_certificates";
DROP TABLE IF EXISTS "commission_tds_rates";
COMMIT;
