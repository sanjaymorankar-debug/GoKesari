-- Rollback for 0073_bank_account_checks (docs/four-features-2026-10, O-7).
-- Run only after the previous code is live, then delete the 0073 row from
-- drizzle.__drizzle_migrations. The history of bank checks is lost (accounts
-- keep their status) — back up first.
DROP TABLE IF EXISTS "bank_account_checks";
