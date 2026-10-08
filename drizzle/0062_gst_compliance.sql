-- 0062 GST compliance (docs/three-modules-2026-10, Module 2).
--   gst_rules            thresholds and switches as dated data (seeded below).
--   hsn_tax_rates        fallback rates by HSN, dated — empty, for the CA.
--   credit_notes (+ counters)   the shop's credit note on a refund after delivery.
--   einvoice_records / eway_bills   IRN + signed QR / e-way bill through a GSP.
--   gstin_lookups        GSTIN validation results through the GSP.
--   gst_return_exports   who downloaded which GSTR-1-ready export.
--   shops.einvoice_applicable (+ declared turnover band)   per shop.
--   tax_invoices: invoice numbers unique per shop (was: across all shops), as
--     GST requires — needed for the 16-character numbering. Every existing
--     number is already unique, so the new index builds on any data.
-- Rollback: scripts/rollback-0062.sql
CREATE TABLE "credit_note_counters" (
	"shop_id" uuid NOT NULL,
	"financial_year" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credit_note_counters_shop_id_financial_year_pk" PRIMARY KEY("shop_id","financial_year")
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"tax_invoice_id" uuid NOT NULL,
	"credit_note_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"reason" text NOT NULL,
	"restock" boolean DEFAULT false NOT NULL,
	"source_ref" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_notes_total_positive" CHECK ("credit_notes"."total_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "einvoice_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_invoice_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"gsp" text NOT NULL,
	"request_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"irn" text,
	"ack_no" text,
	"ack_date" timestamp with time zone,
	"signed_invoice" text,
	"signed_qr" text,
	"error_code" text,
	"error_message" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eway_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_invoice_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"gsp" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"ewb_no" text,
	"valid_upto" timestamp with time zone,
	"distance_km" integer,
	"vehicle_no" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_return_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"period" text NOT NULL,
	"format" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gstin_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gstin" text NOT NULL,
	"provider" text NOT NULL,
	"found" boolean NOT NULL,
	"legal_name" text,
	"trade_name" text,
	"status" text,
	"state_code" text,
	"taxpayer_type" text,
	"registration_date" date,
	"address" text,
	"raw" jsonb,
	"looked_up_by" uuid,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hsn_tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hsn_prefix" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"cess_bp" integer DEFAULT 0 NOT NULL,
	"description" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hsn_tax_rates_rate_range" CHECK ("hsn_tax_rates"."rate_bp" BETWEEN 0 AND 10000 AND "hsn_tax_rates"."cess_bp" BETWEEN 0 AND 100000)
);
--> statement-breakpoint
DROP INDEX "tax_invoices_number_unique";--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "einvoice_applicable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "declared_turnover_band" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "turnover_declared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "turnover_declared_by" uuid;--> statement-breakpoint
ALTER TABLE "credit_note_counters" ADD CONSTRAINT "credit_note_counters_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tax_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("tax_invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_tax_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("tax_invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_records" ADD CONSTRAINT "einvoice_records_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_tax_invoice_id_tax_invoices_id_fk" FOREIGN KEY ("tax_invoice_id") REFERENCES "public"."tax_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eway_bills" ADD CONSTRAINT "eway_bills_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_return_exports" ADD CONSTRAINT "gst_return_exports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_return_exports" ADD CONSTRAINT "gst_return_exports_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_rules" ADD CONSTRAINT "gst_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstin_lookups" ADD CONSTRAINT "gstin_lookups_looked_up_by_users_id_fk" FOREIGN KEY ("looked_up_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hsn_tax_rates" ADD CONSTRAINT "hsn_tax_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_source_unique" ON "credit_notes" USING btree ("source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_shop_number_unique" ON "credit_notes" USING btree ("shop_id","credit_note_number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_shop_seq_unique" ON "credit_notes" USING btree ("shop_id","financial_year","sequence");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("tax_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_records_invoice_unique" ON "einvoice_records" USING btree ("tax_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_records_request_unique" ON "einvoice_records" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_records_irn_unique" ON "einvoice_records" USING btree ("irn");--> statement-breakpoint
CREATE UNIQUE INDEX "eway_bills_invoice_unique" ON "eway_bills" USING btree ("tax_invoice_id");--> statement-breakpoint
CREATE INDEX "gst_return_exports_shop_idx" ON "gst_return_exports" USING btree ("shop_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "gst_rules_key_from_unique" ON "gst_rules" USING btree ("key","effective_from");--> statement-breakpoint
CREATE INDEX "gstin_lookups_gstin_idx" ON "gstin_lookups" USING btree ("gstin","looked_up_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hsn_tax_rates_prefix_from_unique" ON "hsn_tax_rates" USING btree ("hsn_prefix","effective_from");--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_turnover_declared_by_users_id_fk" FOREIGN KEY ("turnover_declared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_invoices_shop_number_unique" ON "tax_invoices" USING btree ("shop_id","invoice_number");
--> statement-breakpoint
-- Seed rules. Values follow notifications as understood on 8 Oct 2026; each is
-- data, editable at /admin/gst-config, and should be confirmed by a CA.
INSERT INTO "gst_rules" ("key", "value", "effective_from", "effective_to", "note") VALUES
  ('documentNumbering', '{"format":"LEGACY"}', '2017-07-01', NULL,
   'LEGACY = <shop no>/<FY>/<000001> (25 chars). GST16 = GK<yy><yy>-<000001>, CN<yy><yy>-<000001> (13 chars): Rule 46 and the e-invoice schema allow at most 16. Switch to GST16 before e-invoicing.'),
  ('einvoice', '{"enabled":false,"turnoverThresholdPaise":5000000000,"b2bOnly":true}', '2023-08-01', NULL,
   'E-invoicing for B2B invoices of taxpayers with aggregate turnover above Rs 5 crore in any FY since 2017-18 (Notification 10/2023-CT). enabled = master switch for GoKesari.'),
  ('einvoiceReportingWindow', '{"days":30,"appliesAbovePaise":10000000000}', '2025-04-01', NULL,
   'IRN must be obtained within 30 days of the invoice date for taxpayers with AATO of Rs 10 crore or more. Confirm with CA.'),
  ('b2clThreshold', '{"invoiceValuePaise":25000000}', '2017-07-01', '2024-07-31',
   'GSTR-1 Table 5 (B2C large, inter-state): invoice value above Rs 2.5 lakh.'),
  ('b2clThreshold', '{"invoiceValuePaise":10000000}', '2024-08-01', NULL,
   'GSTR-1 Table 5 (B2C large, inter-state): invoice value above Rs 1 lakh (Notification 12/2024-CT). Confirm with CA.'),
  ('ewayBill', '{"enabled":false,"interStateThresholdPaise":5000000,"intraStateThresholdPaise":{"DEFAULT":5000000}}', '2018-04-01', NULL,
   'E-way bill above Rs 50,000 consignment value. States may set a different intra-state limit: add them under intraStateThresholdPaise by two-letter state code, as the CA advises.'),
  ('gsp', '{"provider":"mock"}', '2017-07-01', NULL,
   'Which GSP adapter is used. mock until a licensed GSP is chosen (env GSP_PROVIDER / GSP_ENV must agree).');
