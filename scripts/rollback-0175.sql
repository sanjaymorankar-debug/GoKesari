-- Rollback of drizzle/0175_rbac_v2_bank_reconciliation.sql. Switch rbac_v2_accounting off first.
-- Drops the imported bank statements and their matches (export them first). Payout, refund, journal and
-- finance tables are not touched: reconciliation only ever read them.
DROP TABLE IF EXISTS "fin_bank_statement_lines";
DROP TABLE IF EXISTS "fin_bank_statements";
DROP FUNCTION IF EXISTS fin_bank_statement_lines_guard();
DROP FUNCTION IF EXISTS fin_bank_statements_guard();
DROP SEQUENCE IF EXISTS "fin_bank_statement_number_seq";
