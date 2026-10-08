-- Reverses drizzle/0059_shop_wallet_delivery_otp.sql (shop wallet + hashed
-- delivery codes). Deploy the previous build and switch rule shopWallet off
-- first. Back up first.
--
-- Shop wallets hold money the shops paid in. This script REFUSES to run while
-- any shop wallet has a non-zero balance, a shop top-up is still open, or an
-- order whose commission was paid from a wallet is not settled yet:
-- settle those first (refund or carry the balances over, recorded outside the
-- app), then run it. Export the ledger before you do:
--   \copy (SELECT * FROM shop_wallet_transactions ORDER BY seq) TO 'shop_wallet_ledger.csv' CSV HEADER
--
-- A drop under way with a hashed code cannot get its plain-text code back.
-- Such deliveries are locked for the previous build (it then says "ask
-- operations to confirm this delivery"), so no drop is ever confirmed without
-- a code; operations confirm them from the exceptions queue.
--
-- Afterwards delete the 0059 row from drizzle.__drizzle_migrations.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM shop_wallets WHERE balance_paise <> 0) THEN
    RAISE EXCEPTION 'shop wallets still hold money: settle every balance to zero before rolling back 0059';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE purpose = 'SHOP_WALLET_TOPUP' AND status IN ('CREATED', 'PENDING')) THEN
    RAISE EXCEPTION 'shop wallet top-ups are still open: wait for them to settle (or mark them FAILED) before rolling back 0059';
  END IF;
  -- The previous build withholds commission at settlement for every order;
  -- these orders already paid it from the wallet.
  IF EXISTS (SELECT 1 FROM order_financials WHERE commission_collection = 'SHOP_WALLET' AND settlement_id IS NULL) THEN
    RAISE EXCEPTION 'orders whose commission was paid from a shop wallet are not settled yet: prepare their settlement before rolling back 0059';
  END IF;
END $$;

UPDATE delivery_orders
   SET delivery_otp = 'LOCK', delivery_otp_attempts = 99
 WHERE status = 'PICKED_UP' AND delivery_otp_hash IS NOT NULL;

DROP TRIGGER IF EXISTS shop_wallet_txn_immutable ON shop_wallet_transactions;
DROP TABLE IF EXISTS shop_wallet_transactions;
DROP TABLE IF EXISTS shop_wallets;
DROP FUNCTION IF EXISTS shop_wallet_txn_apply();
DROP FUNCTION IF EXISTS shop_wallet_txn_immutable();
DROP FUNCTION IF EXISTS shop_wallets_guard();
DROP TYPE IF EXISTS shop_wallet_entry_type;

-- Shop top-up payment rows stay as history (purpose SHOP_WALLET_TOPUP). The
-- previous build's reconciliation reports the successful ones as "wallet credit
-- missing"; mark those records RECONCILED with a note.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_shop_topup_has_shop;
ALTER TABLE payments DROP COLUMN IF EXISTS shop_id;

ALTER TABLE order_financials
  DROP COLUMN IF EXISTS commission_collection,
  DROP COLUMN IF EXISTS shop_delivery_charge_paise;

ALTER TABLE delivery_orders
  DROP COLUMN IF EXISTS delivery_otp_hash,
  DROP COLUMN IF EXISTS delivery_otp_sent_at,
  DROP COLUMN IF EXISTS delivery_otp_resends,
  DROP COLUMN IF EXISTS delivery_otp_used_at,
  DROP COLUMN IF EXISTS delivery_otp_locked_at,
  DROP COLUMN IF EXISTS delivery_otp_ticket_id;
COMMIT;
