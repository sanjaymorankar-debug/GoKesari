ALTER TABLE "orders" ADD COLUMN "placed_while_closed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "expected_open_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_open_alert_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "orders_open_alert_pending_idx" ON "orders" USING btree ("shop_id") WHERE "orders"."placed_while_closed" AND "orders"."shop_open_alert_sent_at" IS NULL;