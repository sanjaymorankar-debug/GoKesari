-- Rollback of drizzle/0225_flows_v3_wave4.sql (docs/flows-v3/wave4.md).
-- Deploy the previous release's code first, then run this and delete the 0225 row from drizzle.__drizzle_migrations.
-- Idempotent. Dropping the invoice tables loses the commission invoices issued while flag flow_f22 was on: export
-- them first (SELECT * FROM dealer_commission_invoices). Payouts drafted with GST keep their total; only the GST
-- columns go, so pay such a draft by hand with its GST noted.
DROP TABLE IF EXISTS "dealer_commission_invoice_counters";
DROP TABLE IF EXISTS "dealer_commission_invoices";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "gst_invoice_id";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "gst_rate_bp";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "gst_paise";
DELETE FROM "feature_flag_changes" WHERE "flag_key" IN ('flow_f7', 'flow_f8', 'flow_f9', 'flow_f10', 'flow_f12', 'flow_f21', 'flow_f22');
DELETE FROM "feature_flags" WHERE "key" IN ('flow_f7', 'flow_f8', 'flow_f9', 'flow_f10', 'flow_f12', 'flow_f21', 'flow_f22');
