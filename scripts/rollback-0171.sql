-- Rollback of drizzle/0171_rbac_v2_accounting.sql. Switch rbac_v2_accounting off first.
-- Drops the RBAC v2 accounting tables (journal entries, periods, rate proposals — export them first).
-- Existing finance tables, commission rates and fees are not touched.
DROP TABLE IF EXISTS "rate_change_proposals";
DROP TABLE IF EXISTS "fin_journal_lines";
DROP TABLE IF EXISTS "fin_journal_entries";
DROP FUNCTION IF EXISTS fin_journal_lines_guard();
DROP FUNCTION IF EXISTS fin_journal_entries_guard();
DROP SEQUENCE IF EXISTS "fin_journal_entry_number_seq";
DROP TABLE IF EXISTS "fin_periods";
