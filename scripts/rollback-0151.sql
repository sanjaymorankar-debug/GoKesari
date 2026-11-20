-- Rollback for 0151_territory_dealers (docs/dealer-programme/TERRITORY_DEALER.md).
-- Before running: switch rule territoryDealer off, deploy the previous release's code, then delete the
-- 0151 row from drizzle.__drizzle_migrations.
-- Checks first: TERRITORY ledger entries and paid territory fees are real money. Export them, and
-- refuse to drop while any TERRITORY entry is in a payout batch:
--   SELECT count(*) FROM dealer_commission_ledger WHERE entry_type = 'TERRITORY';
--   SELECT count(*) FROM dealer_territory_fees WHERE status = 'PAID';
--   SELECT count(*) FROM payment_intents WHERE purpose = 'TERRITORY_FEE';
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dealer_commission_ledger WHERE entry_type = 'TERRITORY') THEN
    RAISE EXCEPTION 'TERRITORY ledger entries exist: export and remove them by hand first';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_intents WHERE purpose = 'TERRITORY_FEE') THEN
    RAISE EXCEPTION 'TERRITORY_FEE payment intents exist: export them first';
  END IF;
END $$;
DROP TABLE IF EXISTS "dealer_territory_order_shares";
DROP TABLE IF EXISTS "dealer_territory_ratings";
DROP TABLE IF EXISTS "dealer_territory_fees";
DROP TABLE IF EXISTS "dealer_territory_pincodes";
DROP TABLE IF EXISTS "dealer_exclusive_territories";
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_entry_type";
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_entry_type" CHECK ("entry_type" in ('BASE', 'DIRECT_1', 'DIRECT_2', 'OVERRIDE_LEAD', 'OVERRIDE_MAIN', 'RENEWAL', 'DEVELOPMENT', 'BONUS'));
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_shop";
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_shop" CHECK ("shop_id" IS NOT NULL OR "entry_type" = 'BONUS');
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE', 'SUPPORT_SERVICE'));
COMMIT;
