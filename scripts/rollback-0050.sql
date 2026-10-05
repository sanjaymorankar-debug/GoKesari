-- Reverses drizzle/0050_customer_referrals.sql. Afterwards delete the 0050 row from drizzle.__drizzle_migrations.
-- Rewards already credited stay in wallets (wallet_transactions, idempotency key referral:<id>:...).
DROP TABLE IF EXISTS "customer_referrals";
DROP TABLE IF EXISTS "customer_referral_codes";
