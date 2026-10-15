-- 0076 Inventory & Accounting for shop owners (docs/inventory-accounting-2026-10).
-- New tables only (inv_*, acc_*, gst_itc_records, gst_portal_*, gst_recon_items,
-- gst_reminders), all keyed by shop_id and owned by the SELLER database in the
-- seller/customer split; three triggers that copy stock changes into the new
-- ledger. No existing table or column changes. Rollback: scripts/rollback-0076.sql
CREATE TABLE "acc_change_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"reason" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_counters" (
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fy" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "acc_counters_shop_id_kind_fy_pk" PRIMARY KEY("shop_id","kind","fy")
);
--> statement-breakpoint
CREATE TABLE "acc_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"expense_date" date NOT NULL,
	"mode" text NOT NULL,
	"party_id" uuid,
	"amount_paise" bigint NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"file_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acc_expenses_amounts" CHECK ("acc_expenses"."amount_paise" > 0 AND "acc_expenses"."gst_paise" >= 0 AND "acc_expenses"."gst_paise" <= "acc_expenses"."amount_paise")
);
--> statement-breakpoint
CREATE TABLE "acc_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"original_name" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text,
	"data" "bytea",
	"encrypted" boolean DEFAULT false NOT NULL,
	"page_no" integer,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"voucher_type" text NOT NULL,
	"entry_date" date NOT NULL,
	"account" text NOT NULL,
	"party_id" uuid,
	"sub_account" text,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"doc_ref" text,
	"narration" text,
	"reverses_voucher_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acc_ledger_entries_one_side" CHECK (("acc_ledger_entries"."debit_paise" >= 0 AND "acc_ledger_entries"."credit_paise" >= 0) AND ("acc_ledger_entries"."debit_paise" = 0 OR "acc_ledger_entries"."credit_paise" = 0))
);
--> statement-breakpoint
CREATE TABLE "acc_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"state_code" text,
	"phone" text,
	"email" text,
	"address" text,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"opening_balance_paise" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"mode" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"payment_date" date NOT NULL,
	"purchase_invoice_id" uuid,
	"sales_invoice_id" uuid,
	"reference" text,
	"note" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acc_payments_positive" CHECK ("acc_payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "acc_purchase_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"supplier_key" text NOT NULL,
	"supplier_gstin" text,
	"supplier_name" text NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"place_of_supply" text,
	"inter_state" boolean DEFAULT false NOT NULL,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"irn" text,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"other_charges_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"itc_eligible" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'CONFIRMED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"capture_id" uuid,
	"file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"engine" text DEFAULT 'MANUAL' NOT NULL,
	"note" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acc_purchase_invoices_amounts" CHECK ("acc_purchase_invoices"."taxable_paise" >= 0 AND "acc_purchase_invoices"."cgst_paise" >= 0 AND "acc_purchase_invoices"."sgst_paise" >= 0 AND "acc_purchase_invoices"."igst_paise" >= 0 AND "acc_purchase_invoices"."cess_paise" >= 0 AND "acc_purchase_invoices"."total_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "acc_purchase_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"shop_product_id" uuid,
	"description" text NOT NULL,
	"hsn" text,
	"qty_milli" bigint NOT NULL,
	"unit" text,
	"stock_qty_milli" bigint,
	"rate_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"batch_no" text,
	"expiry_date" date,
	"mrp_paise" bigint
);
--> statement-breakpoint
CREATE TABLE "acc_sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"party_id" uuid,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"buyer_name" text,
	"buyer_gstin" text,
	"place_of_supply" text NOT NULL,
	"seller_state_code" text NOT NULL,
	"inter_state" boolean NOT NULL,
	"payment_mode" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cancel_reason" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_sales_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"shop_product_id" uuid,
	"description" text NOT NULL,
	"hsn" text,
	"qty_milli" bigint NOT NULL,
	"unit" text,
	"rate_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_itc_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"purchase_invoice_id" uuid NOT NULL,
	"purchase_version" integer NOT NULL,
	"period" text NOT NULL,
	"supplier_gstin" text,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING_RECON' NOT NULL,
	"portal_invoice_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_portal_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"period" text NOT NULL,
	"source" text NOT NULL,
	"file_id" uuid,
	"gstin_in_file" text,
	"invoice_count" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_portal_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"period" text NOT NULL,
	"section" text NOT NULL,
	"doc_type" text DEFAULT 'INV' NOT NULL,
	"counterparty_gstin" text NOT NULL,
	"counterparty_name" text,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"place_of_supply" text,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"itc_available" boolean,
	"irn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_portal_links" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"gstin" text NOT NULL,
	"portal_username" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"consent_text" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"credentials_encrypted" text,
	"token_expires_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_recon_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"portal_invoice_id" uuid,
	"purchase_invoice_id" uuid,
	"supplier_gstin" text,
	"invoice_no" text NOT NULL,
	"invoice_date" date,
	"books_total_paise" bigint,
	"portal_total_paise" bigint,
	"books_tax_paise" bigint,
	"portal_tax_paise" bigint,
	"note" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"period" text NOT NULL,
	"due_date" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_product_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"mfg_date" date,
	"expiry_date" date,
	"mrp_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_bill_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"stage" text,
	"engine" text,
	"file_ids" uuid[] NOT NULL,
	"draft" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"purchase_invoice_id" uuid,
	"created_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_product_settings" (
	"shop_product_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"track_batches" boolean DEFAULT false NOT NULL,
	"last_purchase_rate_paise" bigint,
	"last_purchase_at" timestamp with time zone,
	"last_supplier_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_settings" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"valuation_method" text DEFAULT 'FIFO' NOT NULL,
	"purchase_channel" text DEFAULT 'ONLINE' NOT NULL,
	"filing_frequency" text DEFAULT 'MONTHLY' NOT NULL,
	"sales_invoice_prefix" text DEFAULT 'S' NOT NULL,
	"reminder_days_before" integer DEFAULT 3 NOT NULL,
	"expiry_alert_days" integer DEFAULT 30 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_settings_days_sane" CHECK ("inv_settings"."reminder_days_before" BETWEEN 0 AND 30 AND "inv_settings"."expiry_alert_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
CREATE TABLE "inv_stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_product_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"movement_type" text NOT NULL,
	"qty_milli" bigint NOT NULL,
	"unit_cost_paise" bigint,
	"unit_price_paise" bigint,
	"batch_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"source_line_id" uuid,
	"doc_ref" text,
	"order_id" uuid,
	"inventory_movement_id" uuid,
	"reverses_id" uuid,
	"txid" bigint,
	"entry_date" date DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_stock_ledger_qty_nonzero" CHECK ("inv_stock_ledger"."qty_milli" <> 0)
);
--> statement-breakpoint
CREATE TABLE "inv_supplier_item_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"supplier_key" text NOT NULL,
	"item_key" text NOT NULL,
	"shop_product_id" uuid NOT NULL,
	"unit" text,
	"milli_per_unit" bigint,
	"times_used" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_unit_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_product_id" uuid,
	"unit" text NOT NULL,
	"milli_per_unit" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_unit_conversions_positive" CHECK ("inv_unit_conversions"."milli_per_unit" > 0)
);
--> statement-breakpoint
ALTER TABLE "acc_change_log" ADD CONSTRAINT "acc_change_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_counters" ADD CONSTRAINT "acc_counters_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_expenses" ADD CONSTRAINT "acc_expenses_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_expenses" ADD CONSTRAINT "acc_expenses_party_id_acc_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."acc_parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_expenses" ADD CONSTRAINT "acc_expenses_file_id_acc_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."acc_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_files" ADD CONSTRAINT "acc_files_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_ledger_entries" ADD CONSTRAINT "acc_ledger_entries_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_ledger_entries" ADD CONSTRAINT "acc_ledger_entries_party_id_acc_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."acc_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_parties" ADD CONSTRAINT "acc_parties_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_payments" ADD CONSTRAINT "acc_payments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_payments" ADD CONSTRAINT "acc_payments_party_id_acc_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."acc_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_payments" ADD CONSTRAINT "acc_payments_purchase_invoice_id_acc_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."acc_purchase_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_payments" ADD CONSTRAINT "acc_payments_sales_invoice_id_acc_sales_invoices_id_fk" FOREIGN KEY ("sales_invoice_id") REFERENCES "public"."acc_sales_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_purchase_invoices" ADD CONSTRAINT "acc_purchase_invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_purchase_invoices" ADD CONSTRAINT "acc_purchase_invoices_party_id_acc_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."acc_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_purchase_lines" ADD CONSTRAINT "acc_purchase_lines_purchase_id_acc_purchase_invoices_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."acc_purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_purchase_lines" ADD CONSTRAINT "acc_purchase_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_purchase_lines" ADD CONSTRAINT "acc_purchase_lines_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_sales_invoices" ADD CONSTRAINT "acc_sales_invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_sales_invoices" ADD CONSTRAINT "acc_sales_invoices_party_id_acc_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."acc_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_sales_lines" ADD CONSTRAINT "acc_sales_lines_sales_id_acc_sales_invoices_id_fk" FOREIGN KEY ("sales_id") REFERENCES "public"."acc_sales_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_sales_lines" ADD CONSTRAINT "acc_sales_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_sales_lines" ADD CONSTRAINT "acc_sales_lines_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_itc_records" ADD CONSTRAINT "gst_itc_records_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_itc_records" ADD CONSTRAINT "gst_itc_records_purchase_invoice_id_acc_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."acc_purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_portal_imports" ADD CONSTRAINT "gst_portal_imports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_portal_imports" ADD CONSTRAINT "gst_portal_imports_file_id_acc_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."acc_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_portal_invoices" ADD CONSTRAINT "gst_portal_invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_portal_invoices" ADD CONSTRAINT "gst_portal_invoices_import_id_gst_portal_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."gst_portal_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_portal_links" ADD CONSTRAINT "gst_portal_links_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_recon_items" ADD CONSTRAINT "gst_recon_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_recon_items" ADD CONSTRAINT "gst_recon_items_portal_invoice_id_gst_portal_invoices_id_fk" FOREIGN KEY ("portal_invoice_id") REFERENCES "public"."gst_portal_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_recon_items" ADD CONSTRAINT "gst_recon_items_purchase_invoice_id_acc_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."acc_purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_reminders" ADD CONSTRAINT "gst_reminders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_batches" ADD CONSTRAINT "inv_batches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_batches" ADD CONSTRAINT "inv_batches_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_bill_captures" ADD CONSTRAINT "inv_bill_captures_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_product_settings" ADD CONSTRAINT "inv_product_settings_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_product_settings" ADD CONSTRAINT "inv_product_settings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_settings" ADD CONSTRAINT "inv_settings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_ledger" ADD CONSTRAINT "inv_stock_ledger_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_ledger" ADD CONSTRAINT "inv_stock_ledger_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_ledger" ADD CONSTRAINT "inv_stock_ledger_batch_id_inv_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."inv_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_ledger" ADD CONSTRAINT "inv_stock_ledger_reverses_id_inv_stock_ledger_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."inv_stock_ledger"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_supplier_item_maps" ADD CONSTRAINT "inv_supplier_item_maps_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_supplier_item_maps" ADD CONSTRAINT "inv_supplier_item_maps_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_unit_conversions" ADD CONSTRAINT "inv_unit_conversions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_unit_conversions" ADD CONSTRAINT "inv_unit_conversions_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acc_change_log_entity_idx" ON "acc_change_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "acc_change_log_shop_idx" ON "acc_change_log" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "acc_expenses_shop_idx" ON "acc_expenses" USING btree ("shop_id","expense_date");--> statement-breakpoint
CREATE INDEX "acc_files_shop_idx" ON "acc_files" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "acc_files_sha_idx" ON "acc_files" USING btree ("shop_id","sha256");--> statement-breakpoint
CREATE INDEX "acc_ledger_entries_shop_date_idx" ON "acc_ledger_entries" USING btree ("shop_id","entry_date");--> statement-breakpoint
CREATE INDEX "acc_ledger_entries_voucher_idx" ON "acc_ledger_entries" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "acc_ledger_entries_party_idx" ON "acc_ledger_entries" USING btree ("party_id","entry_date");--> statement-breakpoint
CREATE INDEX "acc_ledger_entries_source_idx" ON "acc_ledger_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "acc_parties_shop_idx" ON "acc_parties" USING btree ("shop_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "acc_parties_gstin_unique" ON "acc_parties" USING btree ("shop_id","gstin") WHERE "acc_parties"."gstin" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "acc_payments_shop_idx" ON "acc_payments" USING btree ("shop_id","payment_date");--> statement-breakpoint
CREATE INDEX "acc_payments_party_idx" ON "acc_payments" USING btree ("party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acc_purchase_invoices_dup_unique" ON "acc_purchase_invoices" USING btree ("shop_id","supplier_key",upper("invoice_no")) WHERE "acc_purchase_invoices"."status" = 'CONFIRMED';--> statement-breakpoint
CREATE INDEX "acc_purchase_invoices_shop_date_idx" ON "acc_purchase_invoices" USING btree ("shop_id","invoice_date");--> statement-breakpoint
CREATE INDEX "acc_purchase_invoices_party_idx" ON "acc_purchase_invoices" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "acc_purchase_lines_purchase_idx" ON "acc_purchase_lines" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "acc_purchase_lines_sp_idx" ON "acc_purchase_lines" USING btree ("shop_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acc_sales_invoices_no_unique" ON "acc_sales_invoices" USING btree ("shop_id","invoice_no");--> statement-breakpoint
CREATE INDEX "acc_sales_invoices_shop_date_idx" ON "acc_sales_invoices" USING btree ("shop_id","invoice_date");--> statement-breakpoint
CREATE INDEX "acc_sales_lines_sales_idx" ON "acc_sales_lines" USING btree ("sales_id");--> statement-breakpoint
CREATE INDEX "gst_itc_records_shop_period_idx" ON "gst_itc_records" USING btree ("shop_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "gst_itc_records_current_unique" ON "gst_itc_records" USING btree ("purchase_invoice_id") WHERE "gst_itc_records"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "gst_portal_imports_shop_idx" ON "gst_portal_imports" USING btree ("shop_id","return_type","period");--> statement-breakpoint
CREATE UNIQUE INDEX "gst_portal_invoices_unique" ON "gst_portal_invoices" USING btree ("shop_id","return_type","period","counterparty_gstin","doc_type",upper("invoice_no"));--> statement-breakpoint
CREATE INDEX "gst_portal_invoices_lookup_idx" ON "gst_portal_invoices" USING btree ("shop_id","counterparty_gstin");--> statement-breakpoint
CREATE INDEX "gst_recon_items_shop_period_idx" ON "gst_recon_items" USING btree ("shop_id","period","status");--> statement-breakpoint
CREATE UNIQUE INDEX "gst_reminders_unique" ON "gst_reminders" USING btree ("shop_id","return_type","period");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_batches_unique" ON "inv_batches" USING btree ("shop_product_id","batch_no");--> statement-breakpoint
CREATE INDEX "inv_batches_expiry_idx" ON "inv_batches" USING btree ("shop_id","expiry_date");--> statement-breakpoint
CREATE INDEX "inv_bill_captures_shop_idx" ON "inv_bill_captures" USING btree ("shop_id","status","created_at");--> statement-breakpoint
CREATE INDEX "inv_bill_captures_queue_idx" ON "inv_bill_captures" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "inv_product_settings_shop_idx" ON "inv_product_settings" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "inv_stock_ledger_sp_idx" ON "inv_stock_ledger" USING btree ("shop_product_id","created_at");--> statement-breakpoint
CREATE INDEX "inv_stock_ledger_shop_date_idx" ON "inv_stock_ledger" USING btree ("shop_id","entry_date");--> statement-breakpoint
CREATE INDEX "inv_stock_ledger_source_idx" ON "inv_stock_ledger" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "inv_stock_ledger_txid_idx" ON "inv_stock_ledger" USING btree ("txid");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_supplier_item_maps_unique" ON "inv_supplier_item_maps" USING btree ("shop_id","supplier_key","item_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_unit_conversions_unique" ON "inv_unit_conversions" USING btree ("shop_id",coalesce("shop_product_id", '00000000-0000-0000-0000-000000000000'::uuid),"unit");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Inventory & Accounting (docs/inventory-accounting-2026-10): the stock
-- ledger follows every change of a listing's stock, in the same transaction,
-- whichever code made it — checkout, cancellation restock, subscriptions,
-- manual edits, spreadsheet uploads. So an online order reduces stock in the
-- books the moment it is placed (event-driven, no cron), and the existing
-- order and catalogue code is not changed at all.
--
--   1. shop_products INSERT with stock      → OPENING row per channel
--   2. shop_products UPDATE of a stock count → a row for the difference
--   3. inventory_movements INSERT            → describes that row (sale for an
--      order, restock on cancellation, manual update) — the movement is
--      always written right after the stock update in the same transaction.
--
-- The accounting module's own postings (purchases, write-offs) write their
-- ledger rows themselves with cost and batch, and switch the triggers off
-- for their transaction only: set_config('gokesari.inv_ledger_managed','on',true).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inv_ledger_managed() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('gokesari.inv_ledger_managed', true), '') = 'on'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_listing_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  IF NEW.online_stock <> 0 THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'ONLINE', 'OPENING', NEW.online_stock::bigint * 1000, 'CATALOGUE', txid_current(), 'Stock entered when the product was listed');
  END IF;
  IF NEW.offline_stock <> 0 THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'OFFLINE', 'OPENING', NEW.offline_stock::bigint * 1000, 'CATALOGUE', txid_current(), 'Stock entered when the product was listed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_listing_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  IF NEW.online_stock IS DISTINCT FROM OLD.online_stock THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'ONLINE', 'ADJUSTMENT', (NEW.online_stock - OLD.online_stock)::bigint * 1000, 'CATALOGUE', txid_current(), 'Stock changed');
  END IF;
  IF NEW.offline_stock IS DISTINCT FROM OLD.offline_stock THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'OFFLINE', 'ADJUSTMENT', (NEW.offline_stock - OLD.offline_stock)::bigint * 1000, 'CATALOGUE', txid_current(), 'Stock changed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  SELECT id INTO target FROM inv_stock_ledger
   WHERE shop_product_id = NEW.shop_product_id
     AND channel = NEW.channel
     AND txid = txid_current()
     AND inventory_movement_id IS NULL
     AND qty_milli = NEW.delta_units::bigint * 1000
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF target IS NULL THEN RETURN NEW; END IF;
  UPDATE inv_stock_ledger SET
    movement_type = CASE
      WHEN NEW.order_id IS NOT NULL AND NEW.delta_units < 0 THEN 'SALE'
      WHEN NEW.order_id IS NOT NULL AND NEW.delta_units > 0 THEN 'SALE_RETURN'
      ELSE 'ADJUSTMENT' END,
    source_type = CASE WHEN NEW.order_id IS NOT NULL THEN 'ORDER' ELSE 'CATALOGUE' END,
    source_id = NEW.order_id,
    order_id = NEW.order_id,
    inventory_movement_id = NEW.id,
    note = NEW.reason,
    created_by = NEW.created_by
  WHERE id = target;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inv_ledger_listing_insert AFTER INSERT ON shop_products FOR EACH ROW EXECUTE FUNCTION inv_ledger_on_listing_insert();
--> statement-breakpoint
CREATE TRIGGER inv_ledger_listing_update AFTER UPDATE OF online_stock, offline_stock ON shop_products FOR EACH ROW EXECUTE FUNCTION inv_ledger_on_listing_update();
--> statement-breakpoint
CREATE TRIGGER inv_ledger_movement AFTER INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION inv_ledger_on_movement();
--> statement-breakpoint
-- Opening balance: the stock every listing holds today, so the ledger sums to
-- shop_products from the first day.
INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, note)
SELECT shop_id, id, 'ONLINE', 'OPENING', online_stock::bigint * 1000, 'MIGRATION', 'Stock on the day the books started'
  FROM shop_products WHERE online_stock <> 0;
--> statement-breakpoint
INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, note)
SELECT shop_id, id, 'OFFLINE', 'OPENING', offline_stock::bigint * 1000, 'MIGRATION', 'Stock on the day the books started'
  FROM shop_products WHERE offline_stock <> 0;
