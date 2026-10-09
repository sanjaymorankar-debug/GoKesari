-- Rollback for 0066_bank_refund_requests (docs/four-features-2026-10).
-- Run only after the previous code is live, then delete the 0066 row from
-- drizzle.__drizzle_migrations. Settle every open request first (paid, failed
-- or cancelled): the wallet movements stay, the request records are lost —
-- back up first.
DROP TABLE IF EXISTS "bank_refund_requests";
