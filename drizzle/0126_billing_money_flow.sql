-- split: core
-- Billing v2, phase 1 (docs/billing): money-flow record per delivered order (§5.1, gap G2), the
-- delivery partner's GST registration (§5.2, G1), the s.9(5) delivery rate change of 1 Nov 2026,
-- and the eleven billing feature flags, all OFF. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0126.sql
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "gst_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "gstin" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_money_flows" (
	"order_id" uuid PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL,
	"payment_method" text NOT NULL,
	"fulfilment" text NOT NULL,
	"mode" text NOT NULL,
	"collected_by" text NOT NULL,
	"tcs_applicable" boolean NOT NULL,
	"tds_applicable" boolean NOT NULL,
	"delivery_gst_liable" text NOT NULL,
	"delivery_gst_rate_bp" integer,
	"delivery_gst_paise" bigint DEFAULT 0 NOT NULL,
	"settlement_status" text DEFAULT 'UNSETTLED' NOT NULL,
	"rule_snapshot" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_money_flows_mode_check" CHECK ("mode" IN ('ONLINE_PREPAID', 'WALLET_PREPAID', 'COD_PLATFORM_RIDER', 'COD_SHOP', 'PICKUP_PAID_AT_SHOP')),
	CONSTRAINT "order_money_flows_collector_check" CHECK ("collected_by" IN ('PLATFORM', 'SHOP')),
	CONSTRAINT "order_money_flows_settlement_check" CHECK ("settlement_status" IN ('UNSETTLED', 'SETTLED', 'REVERSED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_money_flows_shop_idx" ON "order_money_flows" USING btree ("shop_id", "recorded_at");--> statement-breakpoint
-- s.9(5) local delivery: 18% from 22 Sep 2025 to 31 Oct 2026, 5% without ITC from 1 Nov 2026
-- (Notification 09/2026-CT(R), per the build prompt; CA to confirm). Only when the row seeded by 0083
-- is still as seeded — an admin's own edit is left alone. Still read only under the delivery_9_5 flag.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "statutory_rates" WHERE "key" = 'GST_S95_LOCAL_DELIVERY' AND "effective_from" = '2025-09-22'
               AND "effective_to" IS NULL AND "rate_bp" = 1800 AND "confirmed_by_ca" = false)
     AND NOT EXISTS (SELECT 1 FROM "statutory_rates" WHERE "key" = 'GST_S95_LOCAL_DELIVERY' AND "effective_from" = '2026-11-01') THEN
    UPDATE "statutory_rates" SET "effective_to" = '2026-10-31', "enabled" = true, "updated_at" = now(),
           "note" = 'Enabled by 0126 (billing v2); read only while the delivery_9_5 flag is on. CA to confirm GoKesari''s delivery model falls under s.9(5).'
     WHERE "key" = 'GST_S95_LOCAL_DELIVERY' AND "effective_from" = '2025-09-22';
    INSERT INTO "statutory_rates" ("key", "label", "enabled", "rate_bp", "params", "effective_from", "effective_to", "legal_reference", "source_url", "note")
    VALUES ('GST_S95_LOCAL_DELIVERY', 'GST on local delivery services by unregistered persons through the ECO (s.9(5))', true, 500,
            '{"withoutItc": true}'::jsonb, '2026-11-01', NULL,
            'Notification 09/2026-Central Tax (Rate): 5% without input tax credit for time of supply on or after 1 Nov 2026 (as given in the billing build prompt of 1 Nov 2026)',
            NULL, 'Added by 0126 (billing v2). CA to confirm the notification and the rate.');
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES
	('billing_v2', false),
	('tcs_engine', false),
	('tds_engine', false),
	('delivery_9_5', false),
	('gsp_live', false),
	('einvoice', false),
	('ewaybill', false),
	('tally_connector', false),
	('zoho_connector', false),
	('odoo_connector', false),
	('ondc_mode', false)
ON CONFLICT DO NOTHING;
