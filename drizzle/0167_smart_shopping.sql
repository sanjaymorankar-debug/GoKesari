-- Smart shopping, part 1 (owner brief 22-Nov-2026; docs/smart-shopping-2026-11/README.md).
-- Additive and safe to re-run. The AI usage log every AI feature writes (tokens, cost, latency — never the photo or
-- text), and the customer's photo shopping list → wishlist. Products and shops are not referenced by foreign key
-- (seller-side tables); the service checks those links. Feature flag smart_list_scan_enabled: a missing row is OFF.
-- Rollback: scripts/rollback-0167.sql.
CREATE TABLE IF NOT EXISTS "ai_usage_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "feature" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "shop_id" uuid,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" bigint,
  "latency_ms" integer NOT NULL,
  "image_count" smallint NOT NULL DEFAULT 0,
  "outcome" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_log_user_day_idx" ON "ai_usage_log" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_log_feature_idx" ON "ai_usage_log" ("feature", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopping_list_scans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "languages" text[] NOT NULL DEFAULT '{}'::text[],
  "handwritten" boolean,
  "unreadable_reason" text,
  "page_count" smallint NOT NULL,
  "line_count" smallint NOT NULL DEFAULT 0,
  "lines_json" text NOT NULL DEFAULT '[]',
  "photos_expire_at" timestamp with time zone NOT NULL,
  "photos_deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_list_scans_user_idx" ON "shopping_list_scans" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_list_scans_expiry_idx" ON "shopping_list_scans" ("photos_expire_at") WHERE "photos_deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shopping_list_scan_pages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scan_id" uuid NOT NULL REFERENCES "shopping_list_scans"("id") ON DELETE CASCADE,
  "page_no" smallint NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage" text NOT NULL DEFAULT 'DB',
  "storage_key" text,
  "data" bytea,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopping_list_scan_pages_scan_idx" ON "shopping_list_scan_pages" ("scan_id", "page_no");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smart_wishlists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scan_id" uuid REFERENCES "shopping_list_scans"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smart_wishlists_user_idx" ON "smart_wishlists" ("user_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "smart_wishlist_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "wishlist_id" uuid NOT NULL REFERENCES "smart_wishlists"("id") ON DELETE CASCADE,
  "position" smallint NOT NULL,
  "original_text" text,
  "original_lang" text,
  "name_en" text NOT NULL,
  "name_local" text,
  "product_id" uuid,
  "match_confidence" smallint,
  "ai_product_id" uuid,
  "user_edited" boolean NOT NULL DEFAULT false,
  "quantity_amount" numeric(12, 3) NOT NULL,
  "quantity_unit" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "last_order_id" uuid,
  "last_shop_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smart_wishlist_items_list_idx" ON "smart_wishlist_items" ("wishlist_id", "position");
