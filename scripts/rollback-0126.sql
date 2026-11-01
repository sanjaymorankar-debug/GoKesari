-- Rollback for 0126_billing_money_flow (docs/billing). Core database.
-- Before running: switch the billing flags off (Admin → Feature flags) and deploy the previous
-- release's code. order_money_flows is a record of past orders (TCS/TDS evidence): export it first:
--   \copy order_money_flows TO 'order_money_flows.csv' CSV HEADER
-- The s.9(5) rows: the 2026-11-01 row is removed and the 2025-09-22 row reopened and disabled, as
-- 0083 seeded it. Then delete the 0126 row from drizzle.__drizzle_migrations.
BEGIN;
DELETE FROM "feature_flag_changes" WHERE "flag_key" IN ('billing_v2', 'tcs_engine', 'tds_engine', 'delivery_9_5', 'gsp_live', 'einvoice', 'ewaybill', 'tally_connector', 'zoho_connector', 'odoo_connector', 'ondc_mode');
DELETE FROM "feature_flags" WHERE "key" IN ('billing_v2', 'tcs_engine', 'tds_engine', 'delivery_9_5', 'gsp_live', 'einvoice', 'ewaybill', 'tally_connector', 'zoho_connector', 'odoo_connector', 'ondc_mode');
DELETE FROM "statutory_rates" WHERE "key" = 'GST_S95_LOCAL_DELIVERY' AND "effective_from" = '2026-11-01' AND "confirmed_by_ca" = false;
UPDATE "statutory_rates" SET "effective_to" = NULL, "enabled" = false, "updated_at" = now()
 WHERE "key" = 'GST_S95_LOCAL_DELIVERY' AND "effective_from" = '2025-09-22' AND "effective_to" = '2026-10-31';
DROP TABLE IF EXISTS "order_money_flows";
ALTER TABLE "delivery_partners" DROP COLUMN IF EXISTS "gstin";
ALTER TABLE "delivery_partners" DROP COLUMN IF EXISTS "gst_registered";
COMMIT;
