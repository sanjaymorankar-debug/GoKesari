-- 0065 Pickup refunds the delivery fee (docs/four-features-2026-10, feature 1,
-- decision F1-8 as decided by the owner on 9 Oct 2026): when a shop chooses
-- pickup, the customer's delivery fee is given back once, and recorded here.
-- Additive only (two new nullable columns). Rollback: scripts/rollback-0065.sql.
ALTER TABLE "order_fulfilment_arrangements" ADD COLUMN "delivery_fee_refunded_paise" bigint;--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD COLUMN "delivery_fee_refunded_at" timestamp with time zone;