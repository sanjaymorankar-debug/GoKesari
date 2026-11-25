-- Brand search, barcode search and favourites for customers (owner brief 23-Nov-2026, Module 3;
-- docs/search-brand-barcode-favourites-2026-11/).
--
-- * favourites: a signed-in customer's saved catalogue products (one row per user + product). user_id
--   cascades with the account; product_id points at the catalogue (products) and has NO foreign key,
--   like purchase_list_items.shop_product_id: the service checks the product exists before writing and
--   shows a product that has gone as "no longer sold".
-- * brands_name_trgm_idx: brand names are matched with ILIKE '%…%' by the search box and /search.
-- * feature flag brand_barcode_favourites_enabled (OFF): gates the brand group and brand filter in search,
--   /brand/[slug], the customer barcode scan and GET /api/products/barcode, the favourite hearts, /favourites
--   and /api/favourites. Off: the site behaves exactly as before.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0190.sql.
CREATE TABLE IF NOT EXISTS "favourites" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "product_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "favourites_pkey" PRIMARY KEY ("user_id", "product_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favourites_user_created_idx" ON "favourites" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favourites_product_idx" ON "favourites" USING btree ("product_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "brands_name_trgm_idx" ON "brands" USING gin ("name" gin_trgm_ops)';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('brand_barcode_favourites_enabled', false) ON CONFLICT DO NOTHING;
