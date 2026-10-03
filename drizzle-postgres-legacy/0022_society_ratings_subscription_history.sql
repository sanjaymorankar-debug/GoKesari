CREATE TYPE "public"."rating_status" AS ENUM('VISIBLE', 'HIDDEN');--> statement-breakpoint
CREATE TYPE "public"."rating_target" AS ENUM('SHOP', 'DELIVERY_PARTNER');--> statement-breakpoint
CREATE TYPE "public"."society_link_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."society_member_role" AS ENUM('ADMIN', 'OPERATOR', 'RESIDENT');--> statement-breakpoint
CREATE TYPE "public"."society_member_status" AS ENUM('PENDING', 'ACTIVE', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."society_status" AS ENUM('APPLIED', 'VERIFIED', 'REJECTED', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "order_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"target_type" "rating_target" NOT NULL,
	"customer_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"delivery_partner_id" uuid,
	"score" integer NOT NULL,
	"comment" text,
	"status" "rating_status" DEFAULT 'VISIBLE' NOT NULL,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"moderation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_ratings_score_range" CHECK ("order_ratings"."score" BETWEEN 1 AND 5),
	CONSTRAINT "order_ratings_target_partner" CHECK (("order_ratings"."target_type" = 'DELIVERY_PARTNER') = ("order_ratings"."delivery_partner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "societies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"address_line1" text NOT NULL,
	"area" text,
	"city" text NOT NULL,
	"pincode" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"boundary_radius_meters" integer DEFAULT 300 NOT NULL,
	"status" "society_status" DEFAULT 'APPLIED' NOT NULL,
	"delivery_instructions" text,
	"security_notify_enabled" boolean DEFAULT false NOT NULL,
	"exclusive_riders" boolean DEFAULT false NOT NULL,
	"registered_by" uuid,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "societies_boundary_range" CHECK ("societies"."boundary_radius_meters" BETWEEN 50 AND 3000)
);
--> statement-breakpoint
CREATE TABLE "society_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "society_member_role" DEFAULT 'RESIDENT' NOT NULL,
	"status" "society_member_status" DEFAULT 'PENDING' NOT NULL,
	"unit_label" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "society_riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"status" "society_link_status" DEFAULT 'ACTIVE' NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"added_by" uuid,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "society_shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"society_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" "society_link_status" DEFAULT 'ACTIVE' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" "subscription_status",
	"to_status" "subscription_status",
	"note" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "society_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "rating_avg_x100" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grievances" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "society_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "rating_avg_x100" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "societies" ADD CONSTRAINT "societies_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "societies" ADD CONSTRAINT "societies_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_members" ADD CONSTRAINT "society_members_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_members" ADD CONSTRAINT "society_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_members" ADD CONSTRAINT "society_members_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_riders" ADD CONSTRAINT "society_riders_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_riders" ADD CONSTRAINT "society_riders_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_riders" ADD CONSTRAINT "society_riders_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_riders" ADD CONSTRAINT "society_riders_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_shops" ADD CONSTRAINT "society_shops_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_shops" ADD CONSTRAINT "society_shops_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "society_shops" ADD CONSTRAINT "society_shops_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_ratings_order_target_unique" ON "order_ratings" USING btree ("order_id","target_type");--> statement-breakpoint
CREATE INDEX "order_ratings_shop_idx" ON "order_ratings" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "order_ratings_partner_idx" ON "order_ratings" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "societies_slug_unique" ON "societies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "societies_status_idx" ON "societies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "societies_pincode_idx" ON "societies" USING btree ("pincode");--> statement-breakpoint
CREATE UNIQUE INDEX "society_members_unique" ON "society_members" USING btree ("society_id","user_id");--> statement-breakpoint
CREATE INDEX "society_members_user_idx" ON "society_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "society_riders_unique" ON "society_riders" USING btree ("society_id","delivery_partner_id");--> statement-breakpoint
CREATE INDEX "society_riders_partner_idx" ON "society_riders" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "society_shops_unique" ON "society_shops" USING btree ("society_id","shop_id");--> statement-breakpoint
CREATE INDEX "subscription_events_subscription_idx" ON "subscription_events" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_society_id_societies_id_fk" FOREIGN KEY ("society_id") REFERENCES "public"."societies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_society_idx" ON "orders" USING btree ("society_id");