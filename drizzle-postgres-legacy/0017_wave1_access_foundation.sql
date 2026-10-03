CREATE TYPE "public"."order_type" AS ENUM('PERSONAL', 'B2B');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'SOCIETY_ADMIN';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_type" "order_type" DEFAULT 'PERSONAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_shop_id" uuid;--> statement-breakpoint
ALTER TABLE "user_consents" ADD COLUMN "granted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_shop_id_shops_id_fk" FOREIGN KEY ("buyer_shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_buyer_shop_idx" ON "orders" USING btree ("buyer_shop_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_shop_matches_type" CHECK (("orders"."order_type" = 'B2B') = ("orders"."buyer_shop_id" IS NOT NULL));