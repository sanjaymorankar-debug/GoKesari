-- Puja Samagri & Temple Supplies (owner brief, 20-Nov-2026): docs/puja-samagri-2026-11.
-- Additive only: new tables, and new nullable / defaulted columns on product_subcategories.
-- Nothing existing is changed except shop_sells_food(), which gains one OR branch that is
-- false for every shop until it lists a product flagged edible (only the puja catalogue's
-- edible lines are) while the admin's FSSAI toggle is on. Rollback: scripts/rollback-0153.sql.

-- Hindi / Marathi names and search synonyms of a master product (any shop type).
CREATE TABLE IF NOT EXISTS "product_local_names" (
  "product_id" uuid PRIMARY KEY NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "name_hi" text,
  "name_mr" text,
  "synonyms" text[] NOT NULL DEFAULT '{}'::text[],
  -- lower-cased English + Hindi + Marathi names and synonyms, for one ILIKE / trigram match.
  "search_text" text NOT NULL DEFAULT '',
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_local_names_search_trgm_idx" ON "product_local_names" USING gin ("search_text" gin_trgm_ops);
--> statement-breakpoint
-- Catalogue facts the products table does not carry: perishable / edible flags, festivals,
-- variant attributes, the selling unit as the catalogue states it, the "HSN/GST to verify
-- with CA" flag, and the master product an admin merged a duplicate into.
CREATE TABLE IF NOT EXISTS "product_catalogue_attrs" (
  "product_id" uuid PRIMARY KEY NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "catalogue" text NOT NULL DEFAULT 'GENERAL',
  "sell_unit" text,
  "is_perishable" boolean NOT NULL DEFAULT false,
  "is_edible" boolean NOT NULL DEFAULT false,
  "festivals" text[] NOT NULL DEFAULT '{}'::text[],
  "variant_attrs" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "tax_to_verify" boolean NOT NULL DEFAULT false,
  "merged_into_product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_catalogue_attrs_catalogue_idx" ON "product_catalogue_attrs" ("catalogue");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_catalogue_attrs_festivals_idx" ON "product_catalogue_attrs" USING gin ("festivals");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_catalogue_attrs_edible_idx" ON "product_catalogue_attrs" ("product_id") WHERE "is_edible";
--> statement-breakpoint
-- Product types (second level under a category). Every existing row keeps
-- approval_status APPROVED and no owner, so it behaves exactly as before.
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "name_hi" text;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "name_mr" text;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "owner_shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "approval_status" text NOT NULL DEFAULT 'APPROVED';
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "default_unit" text;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "variant_attributes" text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "is_loose" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "is_perishable" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "is_edible" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "review_note" text;
--> statement-breakpoint
ALTER TABLE "product_subcategories" ADD COLUMN IF NOT EXISTS "merged_into_id" uuid REFERENCES "product_subcategories"("id") ON DELETE SET NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "product_subcategories" ADD CONSTRAINT "product_subcategories_approval_known"
    CHECK ("approval_status" IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'MERGED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_subcategories_owner_idx" ON "product_subcategories" ("owner_shop_id") WHERE "owner_shop_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_subcategories_pending_idx" ON "product_subcategories" ("approval_status") WHERE "approval_status" = 'PENDING_APPROVAL';
--> statement-breakpoint
-- A shop of one type that also carries another type's range ("added shop type"). The
-- primary shops.shop_type is unchanged; customer filters by type include these shops.
CREATE TABLE IF NOT EXISTS "shop_added_types" (
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "shop_type_key" text NOT NULL,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("shop_id", "shop_type_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_added_types_type_idx" ON "shop_added_types" ("shop_type_key");
--> statement-breakpoint
-- "Price on confirmation": a customer asks a shop to price a loose / perishable listing
-- that has no price yet; the shop's answer sets the listing price (the cart and orders then
-- work as for any priced listing).
CREATE TABLE IF NOT EXISTS "listing_price_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_product_id" uuid NOT NULL REFERENCES "shop_products"("id") ON DELETE CASCADE,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "quantity" numeric(12, 3),
  "note" text,
  "status" text NOT NULL DEFAULT 'OPEN',
  "price_paise" bigint,
  "answered_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "answered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "listing_price_requests_status_known" CHECK ("status" IN ('OPEN', 'ANSWERED', 'DECLINED', 'CANCELLED')),
  CONSTRAINT "listing_price_requests_price_sane" CHECK ("price_paise" IS NULL OR "price_paise" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_price_requests_shop_idx" ON "listing_price_requests" ("shop_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_price_requests_customer_idx" ON "listing_price_requests" ("customer_id", "created_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listing_price_requests_one_open" ON "listing_price_requests" ("shop_product_id", "customer_id") WHERE "status" = 'OPEN';
--> statement-breakpoint
-- Festival collections: an admin schedules a festival's banner and kit promotion by date
-- range (stored as timestamptz; entered and shown in IST).
CREATE TABLE IF NOT EXISTS "festival_collections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_type_key" text NOT NULL DEFAULT 'PUJA_SAMAGRI',
  "festival_key" text NOT NULL,
  "title" text NOT NULL,
  "title_hi" text,
  "title_mr" text,
  "subtitle" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "home_banner_id" uuid,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "festival_collections_range" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "festival_collections_live_idx" ON "festival_collections" ("shop_type_key", "starts_at", "ends_at") WHERE "active";
--> statement-breakpoint
-- FSSAI for edible catalogue lines (brief §6): a shop that lists a product flagged edible
-- needs FSSAI while the admin toggle (platform_settings 'pujaSamagri'.edibleNeedsFssai,
-- default on) is on. The first three branches are 0097's, unchanged.
CREATE OR REPLACE FUNCTION shop_sells_food(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_type = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE'])
      OR EXISTS (SELECT 1 FROM shop_types st WHERE st.key = p_type AND st.is_food)
      OR EXISTS (
        SELECT 1 FROM shop_product_categories spc
          JOIN product_categories pc ON pc.id = spc.category_id
         WHERE spc.shop_id = p_shop
           AND (pc.department = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE'])
                OR EXISTS (SELECT 1 FROM shop_types st WHERE st.key = pc.department AND st.is_food)))
      OR (
        COALESCE((SELECT (ps.value ->> 'edibleNeedsFssai')::boolean FROM platform_settings ps WHERE ps.key = 'pujaSamagri'), true)
        AND EXISTS (
          SELECT 1 FROM shop_products sp
            JOIN product_catalogue_attrs pca ON pca.product_id = sp.product_id AND pca.is_edible
           WHERE sp.shop_id = p_shop AND sp.deleted_at IS NULL AND sp.is_active))
$$;
