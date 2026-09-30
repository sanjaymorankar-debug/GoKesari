ALTER TABLE "products" ADD COLUMN "default_low_stock_threshold" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "default_reorder_level" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "default_reorder_quantity" integer;--> statement-breakpoint
ALTER TABLE "shop_products" ADD COLUMN "stock_alerts_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "default_low_stock_threshold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "default_reorder_level" integer;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "default_reorder_quantity" integer;