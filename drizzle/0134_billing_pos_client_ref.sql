-- split: seller
-- Billing v2, phase 8 (docs/billing §4.7): counter bills made offline carry the device's own id,
-- so syncing one twice returns the same invoice. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0134.sql
ALTER TABLE "acc_sales_invoices" ADD COLUMN IF NOT EXISTS "client_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acc_sales_invoices_client_ref_uq" ON "acc_sales_invoices" USING btree ("shop_id", "client_ref") WHERE "client_ref" IS NOT NULL;
