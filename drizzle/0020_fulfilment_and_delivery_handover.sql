CREATE TYPE "public"."order_item_fulfilment" AS ENUM('PENDING', 'PICKED', 'SUBSTITUTION_PROPOSED', 'SUBSTITUTED', 'REMOVED');--> statement-breakpoint
ALTER TYPE "public"."delivery_order_status" ADD VALUE 'FAILED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'ACCEPTED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'ASSIGNED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'PICKED_UP';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'FAILED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'RETURNED';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'DISPUTED';--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "pickup_code" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "out_for_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_confirmation" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "proof_note" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "rejected_partner_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfilment_status" "order_item_fulfilment" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "substitute_shop_product_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "substitute_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "substitute_unit_snapshot" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "substitute_quantity_milli" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "substitute_line_total_paise" bigint;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfilment_note" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfilment_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_substitute_shop_product_id_shop_products_id_fk" FOREIGN KEY ("substitute_shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE restrict ON UPDATE no action;