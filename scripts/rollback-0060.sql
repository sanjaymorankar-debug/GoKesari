-- Reverses drizzle/0060_shop_wallet_per_km_refunds.sql (delivery charge per km,
-- commission returned on refunds). Deploy the previous build first. Back up first.
--
-- The previous build charges the flat shopWallet.deliveryChargePaise: set it
-- back (e.g. 2500 = ₹25) in Admin → Business rules, or it charges ₹0.
--
-- Postgres cannot drop an enum value, so COMMISSION_REFUND stays in
-- shop_wallet_entry_type (the previous build never writes it). Ledger rows
-- cannot be removed: if commission refunds were already credited, the CHECK
-- keeps accepting them as credits; otherwise it is restored to its 0059 form.
--
-- Afterwards delete the 0060 row from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE order_financials DROP COLUMN IF EXISTS shop_delivery_distance_m;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shop_wallet_transactions WHERE type::text = 'COMMISSION_REFUND') THEN
    ALTER TABLE shop_wallet_transactions DROP CONSTRAINT IF EXISTS shop_wallet_txn_direction_matches_type;
    ALTER TABLE shop_wallet_transactions ADD CONSTRAINT shop_wallet_txn_direction_matches_type
      CHECK ((type IN ('TOP_UP', 'MANUAL_CREDIT')) = (direction = 'CREDIT'));
  END IF;
END $$;
COMMIT;
