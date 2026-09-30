ALTER TABLE "shops" ADD COLUMN "pan_hash" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "shop_act_number" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "shop_act_key" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "udyam_number" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shops_shop_act_key_active_unique" ON "shops" USING btree ("shop_act_key") WHERE "shops"."shop_act_key" IS NOT NULL AND "shops"."deleted_at" IS NULL AND "shops"."status" <> 'REJECTED';--> statement-breakpoint
CREATE INDEX "shops_pan_hash_idx" ON "shops" USING btree ("pan_hash") WHERE "shops"."pan_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shops_udyam_number_idx" ON "shops" USING btree ("udyam_number") WHERE "shops"."udyam_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_shop_act_key_with_number" CHECK (("shops"."shop_act_number" IS NULL) = ("shops"."shop_act_key" IS NULL));