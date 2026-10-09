-- Rollback for 0072_customer_referral_requests (docs/four-features-2026-10).
-- Run only after the previous code is live, then delete the 0072 row from
-- drizzle.__drizzle_migrations. Customer requests are lost (codes already
-- issued stay in referral_codes) — back up first.
DROP TABLE IF EXISTS "customer_referral_requests";
