CREATE TABLE "shop_suspension_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suspension_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status_at_suspension" text NOT NULL,
	"planned_action" text NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_suspensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"expected_action" text NOT NULL,
	"suspended_by" uuid,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_note" text,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shop_suspension_orders" ADD CONSTRAINT "shop_suspension_orders_suspension_id_shop_suspensions_id_fk" FOREIGN KEY ("suspension_id") REFERENCES "public"."shop_suspensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_suspension_orders" ADD CONSTRAINT "shop_suspension_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_suspension_orders" ADD CONSTRAINT "shop_suspension_orders_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_suspensions" ADD CONSTRAINT "shop_suspensions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_suspensions" ADD CONSTRAINT "shop_suspensions_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_suspensions" ADD CONSTRAINT "shop_suspensions_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_suspension_orders_unique" ON "shop_suspension_orders" USING btree ("suspension_id","order_id");--> statement-breakpoint
CREATE INDEX "shop_suspension_orders_order_idx" ON "shop_suspension_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shop_suspension_orders_outcome_idx" ON "shop_suspension_orders" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "shop_suspensions_shop_idx" ON "shop_suspensions" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_suspensions_one_active" ON "shop_suspensions" USING btree ("shop_id") WHERE "shop_suspensions"."status" = 'ACTIVE';