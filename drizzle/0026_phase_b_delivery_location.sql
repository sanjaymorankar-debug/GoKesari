ALTER TABLE "addresses" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "recipient_phone" text;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "address_type" text DEFAULT 'OTHER' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "delivery_pincodes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "min_order_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "orders_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_min_order_non_negative" CHECK ("shops"."min_order_paise" >= 0);