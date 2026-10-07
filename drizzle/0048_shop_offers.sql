-- 0048 Shop offers (F8): a shop's own dated discount on a product or category.
-- New table only. Rollback: scripts/rollback-0048.sql
CREATE TABLE "shop_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_type" text NOT NULL,
	"shop_product_id" uuid,
	"category_id" uuid,
	"discount_type" text NOT NULL,
	"percent" integer,
	"flat_paise" bigint,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_offers_target_valid" CHECK (("shop_offers"."target_type" = 'PRODUCT' AND "shop_offers"."shop_product_id" IS NOT NULL) OR ("shop_offers"."target_type" = 'CATEGORY' AND "shop_offers"."category_id" IS NOT NULL)),
	CONSTRAINT "shop_offers_amount_valid" CHECK (("shop_offers"."discount_type" = 'PERCENT' AND "shop_offers"."percent" BETWEEN 1 AND 90) OR ("shop_offers"."discount_type" = 'FLAT' AND "shop_offers"."flat_paise" > 0)),
	CONSTRAINT "shop_offers_dates_valid" CHECK ("shop_offers"."ends_at" > "shop_offers"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "shop_offers" ADD CONSTRAINT "shop_offers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_offers" ADD CONSTRAINT "shop_offers_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_offers" ADD CONSTRAINT "shop_offers_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_offers" ADD CONSTRAINT "shop_offers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_offers_shop_idx" ON "shop_offers" USING btree ("shop_id","ends_at");