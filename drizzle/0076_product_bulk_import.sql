-- 0076 Bulk product upload (docs/product-import-2026-10).
--   product_import_jobs   one uploaded spreadsheet (Amazon Seller Central
--                         template, GoKesari simple template or CSV): the file,
--                         its status, counts and the inventory mode.
--   product_import_rows   every data row: verbatim cells, parsed fields, the
--                         preview plan, the outcome and its warnings.
--   shop_listing_details  per-listing values shop_products has no column for:
--                         the shop's SKU, the MRP for this shop, a scheduled
--                         sale, lead time, condition, gift options, attributes.
--   product_attributes    lossless attributes of a product an upload created.
--   inventory_movements   + source, import_job_id (nullable): the stock ledger
--                         records which import changed a stock level.
-- Owned by the SELLER database in the seller/customer split (docs/db-split-2026-10).
-- Additive only: new tables and nullable columns; no existing column changes.
-- Rollback: scripts/rollback-0076.sql
CREATE TABLE "product_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid,
	"actor_role" "user_role",
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"file_path" text,
	"file_data" bytea,
	"source_format" text,
	"sheet_name" text,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory_mode" text DEFAULT 'SET' NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"messages" text[] DEFAULT '{}'::text[] NOT NULL,
	"error_message" text,
	"images_status" text DEFAULT 'none' NOT NULL,
	"last_progress_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_import_jobs_status" CHECK ("product_import_jobs"."status" in ('uploaded', 'parsing', 'preview_ready', 'importing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "product_import_jobs_mode" CHECK ("product_import_jobs"."inventory_mode" in ('SET', 'ADD')),
	CONSTRAINT "product_import_jobs_format" CHECK ("product_import_jobs"."source_format" IS NULL OR "product_import_jobs"."source_format" in ('AMAZON_TEMPLATE', 'GOKESARI_TEMPLATE', 'SPREADSHEET', 'CSV')),
	CONSTRAINT "product_import_jobs_images_status" CHECK ("product_import_jobs"."images_status" in ('none', 'queued', 'running', 'done')),
	CONSTRAINT "product_import_jobs_size" CHECK ("product_import_jobs"."file_size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"sku" text,
	"raw_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parsed_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action" text DEFAULT 'UPSERT' NOT NULL,
	"match_type" text,
	"product_id" uuid,
	"listing_id" uuid,
	"plan" jsonb,
	"status" text DEFAULT 'ready' NOT NULL,
	"messages" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_rows" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_import_rows_action" CHECK ("product_import_rows"."action" in ('UPSERT', 'EDIT', 'DELETE')),
	CONSTRAINT "product_import_rows_match" CHECK ("product_import_rows"."match_type" IS NULL OR "product_import_rows"."match_type" in ('SKU', 'BARCODE', 'NAME', 'NEW', 'NONE')),
	CONSTRAINT "product_import_rows_status" CHECK ("product_import_rows"."status" in ('ready', 'skipped', 'created', 'updated', 'deactivated', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "shop_listing_details" (
	"shop_product_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"seller_sku" text,
	"mrp_paise" bigint,
	"sale_price_paise" bigint,
	"sale_starts_on" date,
	"sale_ends_on" date,
	"handling_days" integer,
	"restock_on" date,
	"always_available" boolean,
	"item_condition" text,
	"condition_note" text,
	"gift_wrap" boolean,
	"gift_message" boolean,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_import_job_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_listing_details_money_non_negative" CHECK (("shop_listing_details"."mrp_paise" IS NULL OR "shop_listing_details"."mrp_paise" >= 0) AND ("shop_listing_details"."sale_price_paise" IS NULL OR "shop_listing_details"."sale_price_paise" >= 0))
);
--> statement-breakpoint
CREATE TABLE "product_attributes" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_import_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "import_job_id" uuid;--> statement-breakpoint
-- Auto-generated SKUs for rows without one: GK-<shop>-<seq>.
CREATE SEQUENCE IF NOT EXISTS "product_import_sku_seq" START 1;--> statement-breakpoint
ALTER TABLE "product_import_jobs" ADD CONSTRAINT "product_import_jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_jobs" ADD CONSTRAINT "product_import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."product_import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_listing_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listing_details" ADD CONSTRAINT "shop_listing_details_shop_product_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listing_details" ADD CONSTRAINT "shop_listing_details_shop_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listing_details" ADD CONSTRAINT "shop_listing_details_last_import_job_id_fk" FOREIGN KEY ("last_import_job_id") REFERENCES "public"."product_import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listing_details" ADD CONSTRAINT "shop_listing_details_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_source_import_job_id_fk" FOREIGN KEY ("source_import_job_id") REFERENCES "public"."product_import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_import_jobs_shop_idx" ON "product_import_jobs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "product_import_jobs_hash_idx" ON "product_import_jobs" USING btree ("shop_id","file_hash");--> statement-breakpoint
CREATE INDEX "product_import_jobs_status_idx" ON "product_import_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_rows_row_unique" ON "product_import_rows" USING btree ("job_id","row_number");--> statement-breakpoint
CREATE INDEX "product_import_rows_status_idx" ON "product_import_rows" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_listing_details_sku_unique" ON "shop_listing_details" USING btree ("shop_id",lower("seller_sku")) WHERE "shop_listing_details"."seller_sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "inventory_movements_import_job_idx" ON "inventory_movements" USING btree ("import_job_id") WHERE "inventory_movements"."import_job_id" IS NOT NULL;
