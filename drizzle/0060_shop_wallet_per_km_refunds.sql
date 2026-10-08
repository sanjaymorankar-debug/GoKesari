-- 0060 Shop wallet: delivery charge per km, commission returned on refunds
-- (docs/shop-wallet-delivery-otp-2026-10). Additive; rollback scripts/rollback-0060.sql.
--   shop_wallet_entry_type += COMMISSION_REFUND   a credit of the commission on
--       refunded goods when the shop bears a refund after delivery.
--   shop_wallet_txn_direction_matches_type   now also lets COMMISSION_REFUND be a
--       credit. Compared as text: the migrator runs in one transaction, and a
--       new enum value cannot be used as an enum until it commits.
--   order_financials.shop_delivery_distance_m   the distance (metres, to 0.1 km)
--       the delivery charge was priced on; null when not known.
ALTER TYPE "public"."shop_wallet_entry_type" ADD VALUE IF NOT EXISTS 'COMMISSION_REFUND';--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" DROP CONSTRAINT IF EXISTS "shop_wallet_txn_direction_matches_type";--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN IF NOT EXISTS "shop_delivery_distance_m" integer;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_txn_direction_matches_type" CHECK (("shop_wallet_transactions"."type"::text IN ('TOP_UP', 'MANUAL_CREDIT', 'COMMISSION_REFUND')) = ("shop_wallet_transactions"."direction" = 'CREDIT'));
