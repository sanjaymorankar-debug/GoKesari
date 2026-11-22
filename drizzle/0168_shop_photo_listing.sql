-- Smart shopping, part 2: "Add product by photo + voice" for shop owners (owner brief 22-Nov-2026;
-- docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md). Additive and safe to re-run.
--
-- shop_photo_listings: one row per product shot. What the AI read from the photos (every field with its
-- confidence) is kept next to what the owner published, so the admin report can count "products added by photo"
-- and AI accuracy (fields changed vs kept). Shops, products and listings are seller-side tables and are NOT
-- referenced by foreign key (one-database rule: no keys between seller and customer tables; the service checks
-- those links). created_by references users like ai_usage_log (0167).
--
-- shop_photo_listing_photos: the 1–4 photos the AI read (front, back, label, barcode), re-encoded JPEG without
-- EXIF. A photo the owner published goes through the normal product photo pipeline (stored_images) and its draft
-- copy is deleted at once; the rest are deleted by the daily cron after rule smartShopping.photoRetentionDays.
--
-- Feature flag shop_photo_listing_enabled: a missing row is OFF. Rollback: scripts/rollback-0168.sql.
CREATE TABLE IF NOT EXISTS "shop_photo_listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "unreadable_reason" text,
  "photo_count" smallint NOT NULL DEFAULT 0,
  "local_lang" text NOT NULL DEFAULT 'hi',
  "ai_model" text,
  "ai_fields" jsonb,
  "match_type" text,
  "match_product_id" uuid,
  "match_score" smallint,
  "published_fields" jsonb,
  "changed_fields" text[] NOT NULL DEFAULT '{}'::text[],
  "fields_kept" smallint NOT NULL DEFAULT 0,
  "fields_changed" smallint NOT NULL DEFAULT 0,
  "outcome" text,
  "product_id" uuid,
  "shop_product_id" uuid,
  "price_paise" bigint,
  "price_unit" text,
  "stock" numeric(14, 3),
  "stock_unit" text,
  "custom_unit" text,
  "voice_text" text,
  "photos_expire_at" timestamp with time zone NOT NULL,
  "photos_deleted_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_photo_listings_status_check" CHECK ("status" IN ('DRAFT', 'UNREADABLE', 'PUBLISHED', 'DISCARDED')),
  CONSTRAINT "shop_photo_listings_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('LINKED_MASTER', 'UPDATED_LISTING', 'REUSED_EXISTING', 'CREATED_PENDING', 'CREATED_APPROVED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_photo_listings_shop_idx" ON "shop_photo_listings" ("shop_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_photo_listings_report_idx" ON "shop_photo_listings" ("published_at") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_photo_listings_expiry_idx" ON "shop_photo_listings" ("photos_expire_at") WHERE "photos_deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_photo_listing_photos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "listing_id" uuid NOT NULL REFERENCES "shop_photo_listings"("id") ON DELETE CASCADE,
  "position" smallint NOT NULL,
  "side" text NOT NULL DEFAULT 'FRONT',
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "data" bytea NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_photo_listing_photos_side_check" CHECK ("side" IN ('FRONT', 'BACK', 'LABEL', 'BARCODE', 'OTHER'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_photo_listing_photos_listing_idx" ON "shop_photo_listing_photos" ("listing_id", "position");
