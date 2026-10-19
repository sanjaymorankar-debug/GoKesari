-- Rollback for 0085_split_ledger_marks (seller/customer split: ledger marks).
-- Run only after the previous release's code is live (the migration is additive),
-- then delete the 0085 row from drizzle.__drizzle_migrations. Nothing is lost:
-- marks only matter inside the transaction that wrote them.
BEGIN;
CREATE OR REPLACE FUNCTION inv_ledger_managed() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('gokesari.inv_ledger_managed', true), '') = 'on'
$$;
DROP TABLE IF EXISTS "inv_ledger_marks" CASCADE;
DROP FUNCTION IF EXISTS inv_ledger_marks_stamp();
COMMIT;
