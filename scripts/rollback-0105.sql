-- Rollback for 0105_dealer_attribution (docs/dealer-programme, step 3). Seller database.
-- Run only after the previous release's code is live, then delete the 0105 row from
-- drizzle.__drizzle_migrations. Shop attributions, leads, dealer-assisted sessions and
-- attribution disputes are lost — back up first. Shops, their referral codes and redemptions
-- are untouched (the step never changed them). Run before rollback-0104.sql.
BEGIN;
DROP TABLE IF EXISTS "dealer_attribution_disputes";
DROP TABLE IF EXISTS "dealer_assisted_sessions";
DROP TABLE IF EXISTS "shop_attributions";
DROP TABLE IF EXISTS "dealer_leads";
COMMIT;
