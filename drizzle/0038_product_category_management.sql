-- 0038 Product category management.
--   * product_categories becomes the category master: created_by, updated_at,
--     case-insensitive unique names, and one protected "General" row.
--   * shop_product_categories: which categories each shop carries (many-to-many).
-- Rollback: scripts/rollback-0038.sql
CREATE TABLE "shop_product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_product_categories" ADD CONSTRAINT "shop_product_categories_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_product_categories" ADD CONSTRAINT "shop_product_categories_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_product_categories" ADD CONSTRAINT "shop_product_categories_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_product_categories_unique" ON "shop_product_categories" USING btree ("shop_id","category_id");--> statement-breakpoint
CREATE INDEX "shop_product_categories_category_idx" ON "shop_product_categories" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Category names become unique ignoring case (among live categories). Existing
-- duplicates (e.g. "Biscuits" under two departments) are renamed, never merged,
-- so no product moves: the later row becomes "Biscuits (Bakery)", and if that is
-- still taken, gains a short id suffix. The original names are kept in
-- migration_0038_category_renames so scripts/rollback-0038.sql can restore them.
CREATE TABLE IF NOT EXISTS migration_0038_category_renames (
  category_id uuid PRIMARY KEY,
  old_name text NOT NULL,
  new_name text NOT NULL,
  renamed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id, name, department FROM (
      SELECT id, name, department,
             row_number() OVER (PARTITION BY lower(name) ORDER BY created_at, id) AS rn
      FROM product_categories WHERE deleted_at IS NULL
    ) d WHERE rn > 1
  LOOP
    UPDATE product_categories
       SET name = r.name || ' (' || initcap(replace(r.department::text, '_', ' ')) || ')'
     WHERE id = r.id;
    IF (SELECT count(*) FROM product_categories
         WHERE deleted_at IS NULL
           AND lower(name) = lower(r.name || ' (' || initcap(replace(r.department::text, '_', ' ')) || ')')) > 1 THEN
      UPDATE product_categories SET name = name || ' ' || left(id::text, 4) WHERE id = r.id;
    END IF;
    INSERT INTO migration_0038_category_renames (category_id, old_name, new_name)
    SELECT r.id, r.name, name FROM product_categories WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_name_live_unique" ON "product_categories" USING btree (lower("name")) WHERE "product_categories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_one_system" ON "product_categories" USING btree ("is_system") WHERE "product_categories"."is_system";
--> statement-breakpoint
-- The permanent "General" category. If a live category already called "general"
-- exists it becomes the system row; otherwise one is created.
DO $$
DECLARE existing uuid;
BEGIN
  SELECT id INTO existing FROM product_categories
   WHERE deleted_at IS NULL AND lower(name) = 'general' LIMIT 1;
  IF existing IS NOT NULL THEN
    UPDATE product_categories
       SET is_system = true, name = 'General', is_active = true, updated_at = now()
     WHERE id = existing;
  ELSE
    BEGIN
      INSERT INTO product_categories (department, name, slug, description, sort_order, is_system)
      VALUES ('GENERAL_TRADING', 'General',
              CASE WHEN EXISTS (SELECT 1 FROM product_categories WHERE slug = 'general')
                   THEN 'general-' || left(gen_random_uuid()::text, 8) ELSE 'general' END,
              'Products that do not clearly fit another category.', 9999, true);
    EXCEPTION WHEN unsafe_new_enum_value_usage THEN
      -- Only on a brand-new database, where 0001 added GENERAL_TRADING in this
      -- same transaction. The app then creates General on first use
      -- (ensureGeneralCategory in services/product-categories.ts).
      RAISE NOTICE 'General category deferred to first use (fresh database).';
    END;
  END IF;
END $$;
--> statement-breakpoint
-- General can never be deleted, removed, renamed or deactivated, whatever path
-- the write takes; the service layer gives the friendly message first.
CREATE OR REPLACE FUNCTION product_categories_protect_system() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'The General category cannot be deleted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system AND (
       NEW.is_system IS DISTINCT FROM true
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.deleted_at IS NOT NULL
    OR NEW.is_active IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'The General category cannot be removed, renamed or deactivated.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER product_categories_protect_system
  BEFORE UPDATE OR DELETE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION product_categories_protect_system();
--> statement-breakpoint
-- Visibility moves from "the shop's type" to "the shop's categories". So that no
-- shop loses anything on the day this ships, every live shop is linked to:
--   1. every category of its own department (what its catalogue picker showed), and
--   2. the category of every product it already lists (so no listing pauses).
INSERT INTO shop_product_categories (shop_id, category_id)
SELECT s.id, c.id
  FROM shops s
  JOIN product_categories c ON c.department::text = s.shop_type::text AND c.deleted_at IS NULL
 WHERE s.deleted_at IS NULL
UNION
SELECT DISTINCT sp.shop_id, p.category_id
  FROM shop_products sp
  JOIN products p ON p.id = sp.product_id
  JOIN shops s ON s.id = sp.shop_id
 WHERE sp.deleted_at IS NULL AND s.deleted_at IS NULL
ON CONFLICT (shop_id, category_id) DO NOTHING;
