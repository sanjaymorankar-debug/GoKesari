-- Rollback for 0188_account_self_deletion (Module 7; docs/account-deletion-2026-11/).
-- Before running: deploy the previous release's code, then delete the 0188 row from drizzle.__drizzle_migrations.
-- Accounts already deleted stay anonymised (status DELETED); that cannot be undone and is not touched here.
-- Dropping the table loses the record of honoured requests: export it first if it has rows
--   (\copy account_deletion_requests TO 'account_deletion_requests.csv' CSV HEADER).
DROP TABLE IF EXISTS "account_deletion_requests";
DELETE FROM "feature_flag_changes" WHERE "flag_key" = 'account_self_deletion_enabled';
DELETE FROM "feature_flags" WHERE "key" = 'account_self_deletion_enabled';
