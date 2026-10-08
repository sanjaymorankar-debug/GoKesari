-- 0061 Accounting / inventory integration (docs/three-modules-2026-10, Module 2).
--   shop_integrations              one live connection per shop (Tally, Odoo,
--                                  Zoho Books, myBillBook, Vyapar, generic file);
--                                  secrets AES-256-GCM encrypted.
--   integration_connector_tokens   the Tally connector's sign-in tokens (hashed).
--   integration_item_links         shop-software item ↔ GoKesari product (mapping).
--   integration_jobs               the sync outbox: unique idempotency key, lease,
--                                  retries, plain-language error.
--   integration_sync_log           per-shop log.
--   integration_imports / integration_column_mappings   file adapters.
--   shop_products.hsn_code / gst_rate_bp / cess_bp / external_synced_at
--                                  the shop's own tax classification from its software.
-- Additive. Rollback: scripts/rollback-0061.sql
CREATE TABLE "integration_column_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text DEFAULT 'ITEMS' NOT NULL,
	"mapping" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connector_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"last_connector_version" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"status" text DEFAULT 'UPLOADED' NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb,
	"file_storage" text,
	"file_key" text,
	"file_data" "bytea",
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_item_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_name" text NOT NULL,
	"external_sku" text,
	"external_barcode" text,
	"external_unit" text,
	"product_id" uuid,
	"shop_product_id" uuid,
	"match_method" text,
	"match_status" text DEFAULT 'UNMATCHED' NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_applied_at" timestamp with time zone,
	"last_issue" text,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claimed_by" text,
	"external_ref" text,
	"error_code" text,
	"error_message" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"job_id" uuid,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" text,
	"key_version" integer,
	"webhook_secret_hash" text,
	"last_pull_at" timestamp with time zone,
	"last_push_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"connector_seen_at" timestamp with time zone,
	"connected_by" uuid,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "hsn_code" text;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "gst_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "cess_bp" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "external_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_column_mappings" ADD CONSTRAINT "integration_column_mappings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_column_mappings" ADD CONSTRAINT "integration_column_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connector_tokens" ADD CONSTRAINT "integration_connector_tokens_integration_id_shop_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."shop_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connector_tokens" ADD CONSTRAINT "integration_connector_tokens_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connector_tokens" ADD CONSTRAINT "integration_connector_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_imports" ADD CONSTRAINT "integration_imports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_imports" ADD CONSTRAINT "integration_imports_integration_id_shop_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."shop_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_imports" ADD CONSTRAINT "integration_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_item_links" ADD CONSTRAINT "integration_item_links_integration_id_shop_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."shop_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_item_links" ADD CONSTRAINT "integration_item_links_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_item_links" ADD CONSTRAINT "integration_item_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_item_links" ADD CONSTRAINT "integration_item_links_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_item_links" ADD CONSTRAINT "integration_item_links_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_jobs" ADD CONSTRAINT "integration_jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_jobs" ADD CONSTRAINT "integration_jobs_integration_id_shop_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."shop_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_log" ADD CONSTRAINT "integration_sync_log_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_log" ADD CONSTRAINT "integration_sync_log_integration_id_shop_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."shop_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sync_log" ADD CONSTRAINT "integration_sync_log_job_id_integration_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."integration_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_integrations" ADD CONSTRAINT "shop_integrations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_integrations" ADD CONSTRAINT "shop_integrations_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_column_mappings_unique" ON "integration_column_mappings" USING btree ("shop_id","provider","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connector_tokens_hash_unique" ON "integration_connector_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "integration_connector_tokens_integration_idx" ON "integration_connector_tokens" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "integration_imports_shop_idx" ON "integration_imports" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_item_links_external_unique" ON "integration_item_links" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "integration_item_links_shop_status_idx" ON "integration_item_links" USING btree ("shop_id","match_status");--> statement-breakpoint
CREATE INDEX "integration_item_links_shop_product_idx" ON "integration_item_links" USING btree ("shop_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_jobs_idempotency_unique" ON "integration_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_jobs_due_idx" ON "integration_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_jobs_integration_idx" ON "integration_jobs" USING btree ("integration_id","status");--> statement-breakpoint
CREATE INDEX "integration_jobs_shop_idx" ON "integration_jobs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_sync_log_shop_idx" ON "integration_sync_log" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_integrations_one_live" ON "shop_integrations" USING btree ("shop_id") WHERE "shop_integrations"."status" <> 'DISCONNECTED';--> statement-breakpoint
CREATE INDEX "shop_integrations_shop_idx" ON "shop_integrations" USING btree ("shop_id");