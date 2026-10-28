-- Rollback for 0107_dealer_commission (docs/dealer-programme, step 5). Seller database.
-- Run only after the previous release's code is live, then delete the 0107 row from
-- drizzle.__drizzle_migrations. The commission ledger, payout batches, rules, rating slabs and
-- rating history are lost — export them first (the ledger is a financial record). Run before
-- rollback-0106.sql.
BEGIN;
DROP TABLE IF EXISTS "dealer_commission_ledger";
DROP TABLE IF EXISTS "dealer_payout_batches";
DROP TABLE IF EXISTS "dealer_rating_history";
DROP TABLE IF EXISTS "dealer_rating_slabs";
DROP TABLE IF EXISTS "dealer_commission_settings";
DROP TABLE IF EXISTS "dealer_commission_rules";
ALTER TABLE "shop_attributions" DROP COLUMN IF EXISTS "activated_at";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "activated_shops";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "rating_override_until_shops";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "rating_override";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "rating";
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "start_rating";
COMMIT;
