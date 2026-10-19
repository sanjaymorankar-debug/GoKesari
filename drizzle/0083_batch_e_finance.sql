-- batch-2026-10 0083_batch_e_finance (WS-E): invoices to customers (QR, email),
-- automated shop payouts every N days, GoKesari's own fee invoices to shops,
-- dated statutory settings (TCS / TDS / s.9(5)).
--   payout_cycles, payout_cycle_lines, payout_batches, payout_items,
--   payout_events                     seller database (shop finance)
--   platform_invoice_counters, platform_invoices, platform_invoice_lines,
--   platform_credit_debit_notes       seller database (GoKesari → shop documents)
--   statutory_rates, document_emails  platform (core, customer database)
-- References into the other database (users, bank accounts, orders,
-- adjustments) are plain UUID columns without SQL foreign keys.
-- Additive only: new tables, indexes and idempotent seed rows. Every feature
-- they serve is behind a rule that defaults to OFF (payouts, platformInvoicing,
-- invoiceDelivery). Seeded statutory rows are marked confirmed_by_ca = false.
-- Rollback: DROP the eleven tables above (no existing table is touched).
CREATE TABLE IF NOT EXISTS "payout_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_start" date NOT NULL,
	"cycle_end" date NOT NULL,
	"cycle_days" integer NOT NULL,
	"status" text DEFAULT 'CLOSED' NOT NULL,
	"shop_count" integer DEFAULT 0 NOT NULL,
	"net_payable_paise" bigint DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_cycles_start_unique" ON "payout_cycles" USING btree ("cycle_start");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_cycle_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL CONSTRAINT "payout_cycle_lines_cycle_id_payout_cycles_id_fk" REFERENCES "public"."payout_cycles"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL CONSTRAINT "payout_cycle_lines_shop_id_shops_id_fk" REFERENCES "public"."shops"("id") ON DELETE cascade,
	"line_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"description" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"base_paise" bigint,
	"rate_bp" integer,
	"occurred_on" date NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_cycle_lines_source_unique" ON "payout_cycle_lines" USING btree ("line_type","source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_cycle_lines_cycle_shop_idx" ON "payout_cycle_lines" USING btree ("cycle_id","shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_cycle_lines_occurred_idx" ON "payout_cycle_lines" USING btree ("line_type","occurred_on");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL CONSTRAINT "payout_batches_cycle_id_payout_cycles_id_fk" REFERENCES "public"."payout_cycles"("id") ON DELETE cascade,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"provider" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"file_exported_at" timestamp with time zone,
	"file_checksum" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_batches_cycle_unique" ON "payout_batches" USING btree ("cycle_id") WHERE "payout_batches"."status" <> 'CANCELLED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL CONSTRAINT "payout_items_batch_id_payout_batches_id_fk" REFERENCES "public"."payout_batches"("id") ON DELETE cascade,
	"cycle_id" uuid NOT NULL CONSTRAINT "payout_items_cycle_id_payout_cycles_id_fk" REFERENCES "public"."payout_cycles"("id") ON DELETE cascade,
	"shop_id" uuid NOT NULL CONSTRAINT "payout_items_shop_id_shops_id_fk" REFERENCES "public"."shops"("id") ON DELETE cascade,
	"bank_account_id" uuid,
	"amount_paise" bigint NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"hold_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider" text,
	"provider_ref" text,
	"utr" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"paid_at" timestamp with time zone,
	"marked_by" uuid,
	"carried_into_cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_items_batch_shop_unique" ON "payout_items" USING btree ("batch_id","shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_items_idempotency_unique" ON "payout_items" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_items_utr_unique" ON "payout_items" USING btree ("utr") WHERE "payout_items"."utr" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_items_shop_idx" ON "payout_items" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_items_status_idx" ON "payout_items" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid CONSTRAINT "payout_events_batch_id_payout_batches_id_fk" REFERENCES "public"."payout_batches"("id") ON DELETE cascade,
	"item_id" uuid CONSTRAINT "payout_events_item_id_payout_items_id_fk" REFERENCES "public"."payout_items"("id") ON DELETE cascade,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_events_source_event_unique" ON "payout_events" USING btree ("source","event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_events_item_idx" ON "payout_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_invoice_counters" (
	"series" text NOT NULL,
	"financial_year" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "platform_invoice_counters_series_financial_year_pk" PRIMARY KEY("series","financial_year")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL CONSTRAINT "platform_invoices_shop_id_shops_id_fk" REFERENCES "public"."shops"("id") ON DELETE restrict,
	"cycle_id" uuid CONSTRAINT "platform_invoices_cycle_id_payout_cycles_id_fk" REFERENCES "public"."payout_cycles"("id") ON DELETE set null,
	"invoice_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"supply_type" text NOT NULL,
	"recipient_gstin" text,
	"place_of_supply" text,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"gst_deducted_paise" bigint DEFAULT 0 NOT NULL,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_number_unique" ON "platform_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_seq_unique" ON "platform_invoices" USING btree ("financial_year","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoices_shop_cycle_unique" ON "platform_invoices" USING btree ("shop_id","cycle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_invoices_issued_idx" ON "platform_invoices" USING btree ("issued_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL CONSTRAINT "platform_invoice_lines_invoice_id_platform_invoices_id_fk" REFERENCES "public"."platform_invoices"("id") ON DELETE cascade,
	"line_no" integer NOT NULL,
	"fee_type" text NOT NULL,
	"description" text NOT NULL,
	"sac" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"collected_via" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_invoice_lines_no_unique" ON "platform_invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_credit_debit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL CONSTRAINT "platform_credit_debit_notes_invoice_id_platform_invoices_id_fk" REFERENCES "public"."platform_invoices"("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL CONSTRAINT "platform_credit_debit_notes_shop_id_shops_id_fk" REFERENCES "public"."shops"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"note_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"reason" text NOT NULL,
	"source_ref" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"applied_in_cycle_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_by" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_cd_notes_total_positive" CHECK ("total_paise" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_cd_notes_number_unique" ON "platform_credit_debit_notes" USING btree ("note_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_cd_notes_source_unique" ON "platform_credit_debit_notes" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_cd_notes_invoice_idx" ON "platform_credit_debit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statutory_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_bp" integer,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"legal_reference" text,
	"source_url" text,
	"note" text,
	"confirmed_by_ca" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statutory_rates_rate_range" CHECK ("rate_bp" IS NULL OR "rate_bp" BETWEEN 0 AND 10000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statutory_rates_key_from_unique" ON "statutory_rates" USING btree ("key","effective_from");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"user_id" uuid NOT NULL CONSTRAINT "document_emails_user_id_users_id_fk" REFERENCES "public"."users"("id") ON DELETE cascade,
	"recipient_role" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"to_address" text,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "document_emails_doc_user_unique" ON "document_emails" USING btree ("doc_type","doc_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_emails_due_idx" ON "document_emails" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Statutory settings, seeded UNCONFIRMED (confirmed_by_ca = false): the owner's CA must confirm each row.
INSERT INTO "statutory_rates" ("key", "label", "enabled", "rate_bp", "params", "effective_from", "effective_to", "legal_reference", "source_url", "note") VALUES
('GST_TCS_SEC52', 'GST TCS by the e-commerce operator (s.52 CGST Act)', true, 100, '{"applyToUnregistered": false}'::jsonb, '2018-10-01', '2024-07-09', 'Notification 52/2018-Central Tax: 1% (0.5% CGST + 0.5% SGST/UTGST intra-state, or 1% IGST) of net taxable supplies', NULL, 'Net value = taxable supplies through GoKesari - returns. Historical rate, kept for dating.'),
('GST_TCS_SEC52', 'GST TCS by the e-commerce operator (s.52 CGST Act)', true, 50, '{"applyToUnregistered": false}'::jsonb, '2024-07-10', NULL, 'Notification 15/2024-Central Tax dated 10 Jul 2024: 0.5% total (0.25% CGST + 0.25% SGST/UTGST intra-state, or 0.5% IGST inter-state)', 'https://gstcouncil.gov.in/sites/default/files/2024-09/central-tax-15-2024-11072024.pdf', 'Net value = taxable supplies through GoKesari - returns. CA to confirm.'),
('IT_TDS_194O', 'Income-tax TDS on e-commerce participants (Sec 194-O)', true, 100, '{"noPanRateBp": 500, "exemptIndividualHufUpToPaise": 50000000, "baseExcludesGst": true, "sectionLabel": "Sec 194-O"}'::jsonb, '2020-10-01', '2024-09-30', 'Sec 194-O Income-tax Act 1961 (1%); Sec 206AA (5% without PAN/Aadhaar)', NULL, 'Historical rate, kept for dating.'),
('IT_TDS_194O', 'Income-tax TDS on e-commerce participants (Sec 194-O)', true, 10, '{"noPanRateBp": 500, "exemptIndividualHufUpToPaise": 50000000, "baseExcludesGst": true, "sectionLabel": "Sec 194-O"}'::jsonb, '2024-10-01', '2026-03-31', 'Finance (No. 2) Act 2024: 0.1% of gross sales from 1 Oct 2024; 5% without PAN/Aadhaar (s.206AA); individual/HUF with gross sales up to Rs 5 lakh in the FY who furnish PAN/Aadhaar exempt', NULL, 'CA to confirm whether GST is excluded from the base (baseExcludesGst).'),
('IT_TDS_194O', 'Income-tax TDS on e-commerce participants (s.393 ITA 2025, was Sec 194-O)', true, 10, '{"noPanRateBp": 500, "exemptIndividualHufUpToPaise": 50000000, "baseExcludesGst": true, "sectionLabel": "Sec 194-O / s.393 ITA 2025"}'::jsonb, '2026-04-01', NULL, 'Income-tax Act 2025 s.393(1) (the 194-O entry) from 1 Apr 2026', NULL, 'Label and mapping to s.393 to be confirmed by the CA.'),
('GST_S95_RESTAURANT', 'GST on restaurant services through the ECO (s.9(5))', false, 500, '{"appliesToShopTypes": []}'::jsonb, '2022-01-01', NULL, 's.9(5) CGST Act; Notification 17/2021-Central Tax (Rate): the ECO pays 5% (no ITC) on restaurant services supplied through it', NULL, 'Only if food-service (restaurant) shops are onboarded: list their shop types in appliesToShopTypes and enable. CA to confirm.'),
('GST_S95_LOCAL_DELIVERY', 'GST on local delivery services by unregistered persons through the ECO (s.9(5))', false, 1800, '{}'::jsonb, '2025-09-22', NULL, 'Notifications 15/2025 and 17/2025-Central Tax (Rate): local delivery services through an ECO by unregistered persons notified under s.9(5) at 18%', NULL, 'Disabled. CA to confirm whether GoKesari''s delivery model falls under it.'),
('UNREGISTERED_SELLER_RULES', 'Rules for PAN-only / unregistered sellers', true, NULL, '{"tcsOnUnregistered": false, "tdsOnUnregistered": true, "interStateAllowed": false}'::jsonb, '2017-07-01', NULL, 's.52 (TCS) applies to supplies by registered suppliers; unregistered suppliers may sell through an ECO only intra-state under the notified conditions (Notification 34/2023-Central Tax, from 1 Oct 2023); TDS applies by PAN', NULL, 'Configurable booleans. CA to confirm.'),
('PLATFORM_FEE_GST', 'GST on GoKesari''s fees to shops', true, 1800, '{"rateBpByFeeType": {"COMMISSION": 1800, "DELIVERY_CHARGE": 1800, "PLATFORM_FEE": 1800, "REGISTRATION_FEE": 1800, "BILLING_MANAGEMENT": 1800}}'::jsonb, '2017-07-01', NULL, 'Services by GoKesari to shops: 18% (SAC 9985 / 9968 per platformTaxProfile.sacCodes)', NULL, 'CA to confirm SAC codes and rates.')
ON CONFLICT ("key", "effective_from") DO NOTHING;
