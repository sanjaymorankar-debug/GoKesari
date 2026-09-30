ALTER TABLE "product_images" ADD COLUMN "shop_product_id" uuid;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "stored_image_id" uuid;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "alt_text" text;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_stored_image_id_stored_images_id_fk" FOREIGN KEY ("stored_image_id") REFERENCES "public"."stored_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_images_shop_product_idx" ON "product_images" USING btree ("shop_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_one_primary_product" ON "product_images" USING btree ("product_id") WHERE "product_images"."is_primary" AND "product_images"."shop_product_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_one_primary_listing" ON "product_images" USING btree ("shop_product_id") WHERE "product_images"."is_primary" AND "product_images"."shop_product_id" IS NOT NULL;