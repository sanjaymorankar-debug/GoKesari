-- Rollback for 0137_shop_referrals (docs/dealer-programme/TIERED_COMMISSION.md, Part B).
-- Seller database (on the split layout; the one database otherwise). Before running:
--   1. switch rule shopReferrals off (Admin → Settings) and deploy the previous release's code;
--   2. export shop_referrals if anyone wants the history. Rewards already credited stay in the
--      shops' wallets as ordinary credit (their ledger rows are kept): once the promo column is
--      gone they can be spent like a top-up. To take them back first, reverse each REWARDED row in
--      Admin → Shop referrals before running this.
-- Then delete the 0137 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "shop_referrals";
DROP TABLE IF EXISTS "shop_referral_codes";
ALTER TABLE "shop_wallets" DROP CONSTRAINT IF EXISTS "shop_wallets_promo";
ALTER TABLE "shop_wallets" DROP COLUMN IF EXISTS "promo_balance_paise";
COMMIT;
-- Split layout: the next migrate run re-imports the core's foreign tables (reconcile in scripts/split-migrate.mjs).
