CREATE TYPE "public"."mrp_source" AS ENUM('GS1', 'BRAND', 'ADMIN', 'IMPORT', 'API', 'SELLER_SUBMITTED');--> statement-breakpoint
CREATE TYPE "public"."mrp_verification_status" AS ENUM('UNVERIFIED', 'PENDING_VERIFICATION', 'VERIFIED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('PACKAGED', 'LOOSE');--> statement-breakpoint
CREATE TYPE "public"."stock_alert_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."stock_alert_type" AS ENUM('LOW_STOCK', 'OUT_OF_STOCK', 'REORDER');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_mrp_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"previous_mrp_paise" bigint,
	"new_mrp_paise" bigint NOT NULL,
	"source" "mrp_source" NOT NULL,
	"effective_from" date,
	"reason" text,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_subcategories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_product_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"alert_type" "stock_alert_type" NOT NULL,
	"status" "stock_alert_status" DEFAULT 'OPEN' NOT NULL,
	"stock_at_alert" integer NOT NULL,
	"threshold_at_alert" integer NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "subcategory_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "kind" "product_kind" DEFAULT 'PACKAGED' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gtin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "barcode" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "mrp_paise" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "mrp_source" "mrp_source";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "mrp_effective_from" date;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "mrp_verification_status" "mrp_verification_status" DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "mrp_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hsn_code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gst_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer_name" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer_address" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "country_of_origin" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "net_quantity" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "net_quantity_unit" text;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "low_stock_threshold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "reorder_level" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "reorder_quantity" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "minimum_order_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "maximum_order_quantity" integer;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mrp_history" ADD CONSTRAINT "product_mrp_history_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_mrp_history" ADD CONSTRAINT "product_mrp_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD CONSTRAINT "product_subcategories_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_alerts" ADD CONSTRAINT "stock_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_unique" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "brands_name_idx" ON "brands" USING btree ("name");--> statement-breakpoint
CREATE INDEX "product_images_product_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_mrp_history_product_idx" ON "product_mrp_history" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_subcategories_slug_unique" ON "product_subcategories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "product_subcategories_category_idx" ON "product_subcategories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "stock_alerts_shop_status_idx" ON "stock_alerts" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "stock_alerts_shop_product_idx" ON "stock_alerts" USING btree ("shop_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_alerts_open_unique" ON "stock_alerts" USING btree ("shop_product_id","alert_type") WHERE "stock_alerts"."status" = 'OPEN';--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_subcategory_id_product_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."product_subcategories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_gtin_unique" ON "products" USING btree ("gtin") WHERE "products"."gtin" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "products_barcode_idx" ON "products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "products_subcategory_idx" ON "products" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "shop_products_stock_idx" ON "shop_products" USING btree ("online_stock");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_mrp_non_negative" CHECK ("products"."mrp_paise" IS NULL OR "products"."mrp_paise" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_gst_rate_sane" CHECK ("products"."gst_rate_bp" IS NULL OR ("products"."gst_rate_bp" >= 0 AND "products"."gst_rate_bp" <= 10000));--> statement-breakpoint
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_thresholds_non_negative" CHECK ("shop_products"."low_stock_threshold" >= 0
          AND ("shop_products"."reorder_level" IS NULL OR "shop_products"."reorder_level" >= 0)
          AND ("shop_products"."reorder_quantity" IS NULL OR "shop_products"."reorder_quantity" > 0)
          AND "shop_products"."minimum_order_quantity" > 0
          AND ("shop_products"."maximum_order_quantity" IS NULL OR "shop_products"."maximum_order_quantity" >= "shop_products"."minimum_order_quantity"));