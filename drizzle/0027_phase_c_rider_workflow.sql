CREATE TABLE "dispatch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"search_id" uuid,
	"attempt_no" integer NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"delivery_order_id" uuid,
	"delivery_partner_id" uuid,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rider_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" text DEFAULT 'SEARCHING' NOT NULL,
	"stop_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "arrived_at_shop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "arrived_at_customer_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "gate_entry_mode" text DEFAULT 'OPEN' NOT NULL;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "gate_contact_name" text;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "gate_contact_phone" text;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "share_gate_contact_with_rider" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "societies" ADD COLUMN "notify_customer_at_gate" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_search_id_rider_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."rider_searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_attempts" ADD CONSTRAINT "dispatch_attempts_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_searches" ADD CONSTRAINT "rider_searches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_searches" ADD CONSTRAINT "rider_searches_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_attempts_order_idx" ON "dispatch_attempts" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rider_searches_order_unique" ON "rider_searches" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "rider_searches_status_next_idx" ON "rider_searches" USING btree ("status","next_attempt_at");