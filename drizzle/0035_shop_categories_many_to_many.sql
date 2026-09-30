CREATE TABLE "shop_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_category_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_category_mapping" ADD CONSTRAINT "shop_category_mapping_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_category_mapping" ADD CONSTRAINT "shop_category_mapping_category_id_shop_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."shop_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_categories_slug_unique" ON "shop_categories" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_categories_name_unique" ON "shop_categories" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "shop_category_mapping_unique" ON "shop_category_mapping" USING btree ("shop_id","category_id");--> statement-breakpoint
CREATE INDEX "shop_category_mapping_category_idx" ON "shop_category_mapping" USING btree ("category_id");
--> statement-breakpoint
-- Seed the category list from the existing shop types and map every existing shop to the
-- category matching its shop type, so nothing is uncategorised after the migration.
INSERT INTO "shop_categories" ("name", "slug")
VALUES
  ('Grocery / Kirana Store', 'grocery-kirana'),
  ('Supermarket', 'supermarket'),
  ('Convenience Store', 'convenience-store'),
  ('Fruit and Vegetable Shop', 'fruit-vegetable'),
  ('Dairy Shop', 'dairy'),
  ('Bakery', 'bakery'),
  ('Meat Shop', 'meat-shop'),
  ('Sweet Shop', 'sweet-shop'),
  ('Pharmacy / Medical Store', 'pharmacy'),
  ('Optical Store', 'optical-store'),
  ('Clothing Store', 'clothing-store'),
  ('Footwear Store', 'footwear-store'),
  ('Jewellery Store', 'jewellery-store'),
  ('Cosmetics and Beauty Store', 'cosmetics-beauty'),
  ('Mobile Phone Store', 'mobile-phone-store'),
  ('Electronics Store', 'electronics-store'),
  ('Computer Store', 'computer-store'),
  ('Furniture Store', 'furniture-store'),
  ('Home Appliance Store', 'home-appliance-store'),
  ('Hardware Store', 'hardware-store'),
  ('Paint and Sanitary Store', 'paint-sanitary-store'),
  ('Stationery Store', 'stationery-store'),
  ('Bookstore', 'bookstore'),
  ('Toy Store', 'toy-store'),
  ('Sports Store', 'sports-store'),
  ('Pet Store', 'pet-store'),
  ('Automobile Spare Parts Shop', 'auto-spare-parts'),
  ('Auto Accessories Shop', 'auto-accessories'),
  ('Mobile and Electronics Repair Shop', 'mobile-electronics-repair'),
  ('Gift Shop', 'gift-shop'),
  ('Flower Shop', 'flower-shop'),
  ('Hardware and Building Materials', 'building-materials'),
  ('Electrical Shop', 'electrical-shop'),
  ('Agricultural Supply Store', 'agricultural-supply'),
  ('Poultry Supply Store', 'poultry-supply'),
  ('Restaurant', 'restaurant'),
  ('Fast-Food Outlet', 'fast-food'),
  ('Café / Coffee Shop', 'cafe'),
  ('Medical Equipment Store', 'medical-equipment'),
  ('Printing and Photocopy Shop', 'printing-photocopy'),
  ('General Trading Store', 'general-trading'),
  ('Packaging Materials Shop', 'packaging-materials'),
  ('Wholesale Store', 'wholesale-store'),
  ('Online Store / E-commerce', 'online-store')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "shop_category_mapping" ("shop_id", "category_id")
SELECT s."id", c."id"
FROM "shops" s
JOIN "shop_categories" c ON c."slug" = lower(replace(s."shop_type"::text, '_', '-'))
WHERE s."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
