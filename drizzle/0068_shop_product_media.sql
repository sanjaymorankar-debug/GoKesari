-- 0068 Shop product photos and descriptions (docs/three-modules-2026-10, Module 1).
--   shop_products.short_description / long_description   the shop's own text
--       for a listing; NULL = the master product's description is shown.
--   shop_products.content_updated_at / _by   last change to photos or text.
--   stored_images.storage / storage_key   bytes either in `data` (DB, as
--       before) or in a file under MEDIA_DIR outside the web root (DISK) with
--       a random name; `data` becomes nullable, a CHECK keeps one of the two.
--   stored_image_variants   THUMB and MEDIUM WebP copies of a processed photo
--       (the stored_images row is the LARGE one).
--   shop_staff   people an owner lets edit the shop's photos and descriptions.
--   shop_media_imports / _items   bulk ZIP + CSV uploads (checked, then applied).
-- Additive: every existing row stays storage = 'DB' with its bytes; existing
-- code keeps working. Rollback: scripts/rollback-0068.sql
CREATE TABLE "shop_media_import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_name" text NOT NULL,
	"match_key" text,
	"match_method" text,
	"shop_product_id" uuid,
	"position" integer,
	"status" text NOT NULL,
	"message" text,
	"product_image_id" uuid,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_media_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"status" text DEFAULT 'VALIDATED' NOT NULL,
	"photo_mode" text DEFAULT 'REPLACE' NOT NULL,
	"archive_name" text,
	"archive_bytes" integer,
	"archive_storage" text,
	"archive_key" text,
	"archive_data" "bytea",
	"csv_name" text,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_progress_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text DEFAULT 'CATALOGUE' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stored_image_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stored_image_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"storage" text DEFAULT 'DB' NOT NULL,
	"storage_key" text,
	"data" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_image_variants_bytes_present" CHECK (("stored_image_variants"."storage" = 'DB' AND "stored_image_variants"."data" IS NOT NULL) OR ("stored_image_variants"."storage" = 'DISK' AND "stored_image_variants"."storage_key" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "stored_images" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "short_description" text;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "long_description" text;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "content_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "content_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "stored_images" ADD COLUMN "storage" text DEFAULT 'DB' NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_images" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "shop_media_import_items" ADD CONSTRAINT "shop_media_import_items_import_id_shop_media_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."shop_media_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_media_import_items" ADD CONSTRAINT "shop_media_import_items_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_media_imports" ADD CONSTRAINT "shop_media_imports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_media_imports" ADD CONSTRAINT "shop_media_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_staff" ADD CONSTRAINT "shop_staff_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_image_variants" ADD CONSTRAINT "stored_image_variants_stored_image_id_stored_images_id_fk" FOREIGN KEY ("stored_image_id") REFERENCES "public"."stored_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_media_import_items_import_idx" ON "shop_media_import_items" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "shop_media_imports_shop_idx" ON "shop_media_imports" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_staff_one_active" ON "shop_staff" USING btree ("shop_id","user_id") WHERE "shop_staff"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "shop_staff_user_idx" ON "shop_staff" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_image_variants_unique" ON "stored_image_variants" USING btree ("stored_image_id","variant");--> statement-breakpoint
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_content_updated_by_users_id_fk" FOREIGN KEY ("content_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_images" ADD CONSTRAINT "stored_images_bytes_present" CHECK (("stored_images"."storage" = 'DB' AND "stored_images"."data" IS NOT NULL) OR ("stored_images"."storage" = 'DISK' AND "stored_images"."storage_key" IS NOT NULL));