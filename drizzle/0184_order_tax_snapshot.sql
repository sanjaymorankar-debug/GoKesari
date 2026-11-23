-- Billing: the GST included in each order line, recorded at checkout (docs/billing/ORDER_TAX_SNAPSHOT.md).
--  * order_items: hsn_code, gst_rate_bp, cess_bp (the line's classification when the order was placed),
--    taxable_paise and tax_paise (the GST + cess INCLUDED in line_total_paise; taxable + tax = line total).
--  * orders.tax_included_paise: the sum of the lines' tax_paise. Informational only: prices already include
--    GST, so it is never added to total_paise (orders.tax_paise stays 0).
-- All nullable: orders placed before this release keep NULL ("not recorded"). Additive and safe to re-run.
-- Rollback: scripts/rollback-0184.sql.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "hsn_code" text;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "gst_rate_bp" integer;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "cess_bp" integer;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "taxable_paise" bigint;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "tax_paise" bigint;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_included_paise" bigint;
