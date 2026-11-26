-- Flow spec v3, wave 4 (docs/flows-v3/wave4.md). Flags flow_f7, flow_f8, flow_f9, flow_f10, flow_f12, flow_f21, flow_f22.
--
-- * dealer_payout_batches.gst_paise / gst_rate_bp / gst_invoice_id: GST added to the commission payout of a
--   GST-registered dealer (flag flow_f22). Default 0 / NULL: every existing payout is unchanged.
-- * dealer_commission_invoices: the commission invoice issued for such a payout (one per payout), numbered per
--   financial year like the platform invoices (flag flow_f22).
-- * dealer_commission_invoice_counters: the gapless number series of those invoices, one row per prefix and year.
-- * Flags: ON on the staging database (gokesari_test), OFF everywhere else.
--
-- Additive and safe to re-run: new tables, new columns with defaults, new indexes. Nothing is dropped, renamed or
-- deleted, and no existing row changes.
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "gst_paise" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "gst_rate_bp" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "gst_invoice_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_commission_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "batch_id" uuid NOT NULL REFERENCES "dealer_payout_batches"("id") ON DELETE RESTRICT,
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
  "invoice_number" text NOT NULL,
  "financial_year" text NOT NULL,
  "period_month" text,
  "supplier_gstin" text NOT NULL,
  -- INTRA (CGST + SGST) or INTER (IGST)
  "supply" text NOT NULL,
  "taxable_paise" integer NOT NULL,
  "gst_rate_bp" integer NOT NULL,
  "cgst_paise" integer DEFAULT 0 NOT NULL,
  "sgst_paise" integer DEFAULT 0 NOT NULL,
  "igst_paise" integer DEFAULT 0 NOT NULL,
  "total_paise" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "issued_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_invoices_batch_uq" ON "dealer_commission_invoices" ("batch_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_invoices_number_uq" ON "dealer_commission_invoices" ("invoice_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_invoices_dealer_idx" ON "dealer_commission_invoices" ("dealer_id", "issued_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_commission_invoice_counters" (
  "prefix" text NOT NULL,
  "financial_year" text NOT NULL,
  "last_number" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("prefix", "financial_year")
);
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled")
VALUES
  ('flow_f7', current_database() = 'gokesari_test'),
  ('flow_f8', current_database() = 'gokesari_test'),
  ('flow_f9', current_database() = 'gokesari_test'),
  ('flow_f10', current_database() = 'gokesari_test'),
  ('flow_f12', current_database() = 'gokesari_test'),
  ('flow_f21', current_database() = 'gokesari_test'),
  ('flow_f22', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
