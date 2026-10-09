-- Rollback for 0065_pickup_delivery_fee_refund (docs/four-features-2026-10, feature 1).
-- Run only after the previous code is live, then delete the 0065 row from
-- drizzle.__drizzle_migrations. Refunds already made stay in the wallets and
-- on the orders; only the record of which plan refunded them is lost.
ALTER TABLE "order_fulfilment_arrangements" DROP COLUMN IF EXISTS "delivery_fee_refunded_at";
ALTER TABLE "order_fulfilment_arrangements" DROP COLUMN IF EXISTS "delivery_fee_refunded_paise";
