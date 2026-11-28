-- Rollback of drizzle/0229_fee_pay_later.sql (docs/fee-pay-later-2026-11).
-- Switch flag shop_fee_pay_later_enabled off and deploy the previous release's code first, then run this and delete the
-- 0229 row from drizzle.__drizzle_migrations. The PAYOUT_DEDUCTION value of shop_payment_method cannot be dropped;
-- fee payments already recorded with it stay on the shops' ledgers (they are real payments).
-- Export the history first if it should be kept:  \copy shop_fee_recoveries TO 'fee_recoveries.csv' CSV HEADER
DELETE FROM "status_transition_rules" WHERE "entity_type" = 'SHOP' AND "from_status" = 'PAYMENT_PENDING' AND "to_status" = 'ACTIVE';
DELETE FROM "feature_flags" WHERE "key" = 'shop_fee_pay_later_enabled';
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "fee_deferred_at";
DROP TABLE IF EXISTS "shop_fee_recoveries";
DROP TABLE IF EXISTS "shop_fee_pay_later";
