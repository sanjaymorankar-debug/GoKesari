-- split: seller
-- Owner request (27 Oct 2026): staff add shop types from the admin screen, and six new built-in
-- types arrive (firecracker shop, tent house, event management, consultants, doctor's clinic,
-- super speciality clinic; they live in src/lib/shop-types.ts).
-- The three columns that held a shop type were database enums, so a new type needed a migration.
-- They become plain text with the same values; `shop_types` holds the types staff add. The old
-- enum types are left in place (unused) so nothing that still names them breaks.
CREATE TABLE IF NOT EXISTS "shop_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"standard_goods" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_food" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_types_label_unique" ON "shop_types" USING btree (lower("label"));--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "shop_type" SET DATA TYPE text USING "shop_type"::text;--> statement-breakpoint
ALTER TABLE "commission_rates" ALTER COLUMN "shop_type" SET DATA TYPE text USING "shop_type"::text;--> statement-breakpoint
ALTER TABLE "product_categories" ALTER COLUMN "department" SET DATA TYPE text USING "department"::text;
--> statement-breakpoint
-- Food shops need FSSAI. Same list as before, plus the types staff flagged as food (shop_types.is_food).
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
$$;
