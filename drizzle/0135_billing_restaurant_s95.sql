-- split: core
-- Billing v2 (docs/billing §5.3, gap G17): restaurant services supplied through GoKesari under
-- s.9(5) CGST Act. When the dated statutory row GST_S95_RESTAURANT is enabled for the shop's type
-- (and billing_v2 is on), GoKesari is the deemed supplier: it invoices the food to the customer in
-- its own GSTIN and pays the GST; the restaurant's document is a bill of supply.
--   * platform_delivery_invoices becomes GoKesari's s.9(5) series: kind DELIVERY (as before) or
--     RESTAURANT, one of each per order at most; one gapless counter per financial year.
--   * order_money_flows records who owes the GST on the food and how much.
-- Rollback: scripts/rollback-0135.sql.
ALTER TABLE "platform_delivery_invoices" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'DELIVERY' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "platform_delivery_invoices" ADD CONSTRAINT "platform_delivery_invoices_kind_check" CHECK ("kind" IN ('DELIVERY', 'RESTAURANT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_delivery_invoices_order_kind_uq" ON "platform_delivery_invoices" USING btree ("order_id", "kind");--> statement-breakpoint
DROP INDEX IF EXISTS "platform_delivery_invoices_order_uq";--> statement-breakpoint
ALTER TABLE "order_money_flows" ADD COLUMN IF NOT EXISTS "food_gst_liable" text DEFAULT 'SHOP' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "order_money_flows" ADD CONSTRAINT "order_money_flows_food_gst_liable_check" CHECK ("food_gst_liable" IN ('SHOP', 'GOKESARI_S95'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "order_money_flows" ADD COLUMN IF NOT EXISTS "food_gst_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "order_money_flows" ADD COLUMN IF NOT EXISTS "food_gst_paise" bigint DEFAULT 0 NOT NULL;
