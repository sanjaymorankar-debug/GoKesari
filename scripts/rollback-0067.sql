-- Rollback for 0067_customer_signup_referrals (docs/four-features-2026-10).
-- Run only after the previous code is live, then delete the 0067 row from
-- drizzle.__drizzle_migrations. Which code each customer joined with is lost
-- (friend referrals stay in customer_referrals) — back up first.
DROP TABLE IF EXISTS "customer_signup_referrals";
