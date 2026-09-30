CREATE TABLE "return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity_milli" integer NOT NULL,
	"condition" text NOT NULL,
	"comment" text,
	"image_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refund_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_items_quantity_positive" CHECK ("return_items"."quantity_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "return_pickups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"delivery_partner_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"handover_code" text NOT NULL,
	"handover_attempts" integer DEFAULT 0 NOT NULL,
	"offered_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"en_route_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_reason" text,
	"rejected_partner_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" text DEFAULT 'RETURN_REQUESTED' NOT NULL,
	"reason" text NOT NULL,
	"comment" text,
	"refund_amount_paise" bigint NOT NULL,
	"charge_to" text NOT NULL,
	"pickup_required" boolean DEFAULT true NOT NULL,
	"pickup_address" jsonb,
	"refunded_paise" bigint,
	"refund_adjustment_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"inspected_by" uuid,
	"inspected_at" timestamp with time zone,
	"inspection_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_requests_refund_non_negative" CHECK ("return_requests"."refund_amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by" uuid,
	"changed_by_role" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"purpose" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ALTER COLUMN "delivery_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "return_pickup_id" uuid;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_pickups" ADD CONSTRAINT "return_pickups_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_pickups" ADD CONSTRAINT "return_pickups_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_inspected_by_users_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_status_history" ADD CONSTRAINT "return_status_history_return_id_return_requests_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_status_history" ADD CONSTRAINT "return_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_images" ADD CONSTRAINT "stored_images_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "return_items_return_idx" ON "return_items" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "return_items_order_item_idx" ON "return_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "return_pickups_return_idx" ON "return_pickups" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "return_pickups_partner_idx" ON "return_pickups" USING btree ("delivery_partner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "return_pickups_one_live" ON "return_pickups" USING btree ("return_id") WHERE "return_pickups"."status" IN ('PENDING','OFFERED','ACCEPTED','EN_ROUTE');--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_number_unique" ON "return_requests" USING btree ("return_number");--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "return_requests_user_idx" ON "return_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "return_requests_shop_status_idx" ON "return_requests" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "return_status_history_return_idx" ON "return_status_history" USING btree ("return_id","created_at");--> statement-breakpoint
CREATE INDEX "stored_images_owner_idx" ON "stored_images" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "stored_images_sha_idx" ON "stored_images" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_partner_earnings_return_unique" ON "delivery_partner_earnings" USING btree ("return_pickup_id");