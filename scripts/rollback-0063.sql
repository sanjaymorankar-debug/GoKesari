-- Rollback for 0063_bank_accounts (docs/four-features-2026-10, feature 3).
-- Run only after the previous code is live, then delete the 0063 row from
-- drizzle.__drizzle_migrations. Saved bank accounts and verification records
-- are lost — back up first. Check no ₹1 refund is still PENDING:
--   SELECT count(*) FROM bank_verification_attempts WHERE refund_status = 'PENDING';
DROP TABLE IF EXISTS "bank_verification_attempts";
DROP TABLE IF EXISTS "bank_accounts";
