-- Rollback for 0064_referral_code_requests (docs/four-features-2026-10, feature 4).
-- Run only after the previous code is live, then delete the 0064 row from
-- drizzle.__drizzle_migrations. Requests are lost (codes already issued stay
-- in referral_codes) — back up first.
DROP TABLE IF EXISTS "referral_code_requests";
