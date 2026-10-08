-- 0060 Fulfilment options (docs/four-features-2026-10, feature 1): a shop's own
-- delivery staff, and each order's pickup / own-delivery / GoKesari plan with its
-- time slot. Additive only (two new tables). Rollback: scripts/rollback-0060.sql.
CREATE TABLE "order_fulfilment_arrangements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"option" text NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"staff_id" uuid,
	"staff_link_nonce" text,
	"code_nonce" text,
	"code_hash" text,
	"code_sent_at" timestamp with time zone,
	"code_resends" integer DEFAULT 0 NOT NULL,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"code_locked_at" timestamp with time zone,
	"out_for_delivery_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_via" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_fulfilment_arrangements_window" CHECK ("order_fulfilment_arrangements"."scheduled_end" > "order_fulfilment_arrangements"."scheduled_start"),
	CONSTRAINT "order_fulfilment_arrangements_staff" CHECK ("order_fulfilment_arrangements"."option" <> 'SHOP_DELIVERY' OR "order_fulfilment_arrangements"."staff_id" IS NOT NULL OR "order_fulfilment_arrangements"."completed_at" IS NOT NULL),
	CONSTRAINT "order_fulfilment_arrangements_attempts" CHECK ("order_fulfilment_arrangements"."code_attempts" >= 0 AND "order_fulfilment_arrangements"."code_resends" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shop_delivery_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_staff_id_shop_delivery_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."shop_delivery_staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fulfilment_arrangements" ADD CONSTRAINT "order_fulfilment_arrangements_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD CONSTRAINT "shop_delivery_staff_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_delivery_staff" ADD CONSTRAINT "shop_delivery_staff_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_fulfilment_arrangements_order_uq" ON "order_fulfilment_arrangements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_fulfilment_arrangements_shop_idx" ON "order_fulfilment_arrangements" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "order_fulfilment_arrangements_staff_idx" ON "order_fulfilment_arrangements" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_delivery_staff_shop_phone_uq" ON "shop_delivery_staff" USING btree ("shop_id","phone_e164");--> statement-breakpoint
CREATE INDEX "shop_delivery_staff_shop_idx" ON "shop_delivery_staff" USING btree ("shop_id");