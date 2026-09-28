CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SENT', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('WALLET', 'COD');--> statement-breakpoint
CREATE TYPE "public"."risk_flag_status" AS ENUM('OPEN', 'DISMISSED', 'ACTIONED');--> statement-breakpoint
CREATE TYPE "public"."risk_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."risk_subject" AS ENUM('USER', 'SHOP', 'DELIVERY_PARTNER');--> statement-breakpoint
CREATE TYPE "public"."role_grant_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
ALTER TYPE "public"."financial_adjustment_type" ADD VALUE 'COD_CASH_COLLECTED';--> statement-breakpoint
ALTER TYPE "public"."financial_adjustment_type" ADD VALUE 'COD_CASH_DEPOSITED';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'COD_CASH';--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"notification_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "delivery_partner_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"offer_text" text,
	"max_recipients" integer NOT NULL,
	"attribution_days" integer DEFAULT 7 NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"sent_at" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaigns_max_recipients" CHECK ("marketing_campaigns"."max_recipients" BETWEEN 1 AND 5000),
	CONSTRAINT "marketing_campaigns_attribution_days" CHECK ("marketing_campaigns"."attribution_days" BETWEEN 1 AND 30)
);
--> statement-breakpoint
CREATE TABLE "risk_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "risk_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"severity" "risk_severity" NOT NULL,
	"status" "risk_flag_status" DEFAULT 'OPEN' NOT NULL,
	"summary" text NOT NULL,
	"details" jsonb,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "user_role_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "role_grant_status" DEFAULT 'ACTIVE' NOT NULL,
	"source" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" uuid,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method" "payment_method" DEFAULT 'WALLET' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_key" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cod_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "cod_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_segments" ADD CONSTRAINT "customer_segments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_segments" ADD CONSTRAINT "customer_segments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partner_sessions" ADD CONSTRAINT "delivery_partner_sessions_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_segment_id_customer_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."customer_segments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_flags" ADD CONSTRAINT "risk_flags_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_grants" ADD CONSTRAINT "user_role_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_grants" ADD CONSTRAINT "user_role_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_grants" ADD CONSTRAINT "user_role_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_unique" ON "campaign_recipients" USING btree ("campaign_id","user_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_user_idx" ON "campaign_recipients" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "customer_segments_shop_idx" ON "customer_segments" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "delivery_partner_sessions_partner_idx" ON "delivery_partner_sessions" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE INDEX "delivery_partner_sessions_started_idx" ON "delivery_partner_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "marketing_campaigns_shop_idx" ON "marketing_campaigns" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "marketing_campaigns_status_idx" ON "marketing_campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_flags_open_unique" ON "risk_flags" USING btree ("subject_type","subject_id","rule_code") WHERE "risk_flags"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "risk_flags_status_idx" ON "risk_flags" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "risk_flags_subject_idx" ON "risk_flags" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_grants_user_role_unique" ON "user_role_grants" USING btree ("user_id","role");--> statement-breakpoint
CREATE INDEX "user_role_grants_user_idx" ON "user_role_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_key_unique" ON "orders" USING btree ("checkout_key");--> statement-breakpoint
-- GS-003 backfill: every existing non-customer role becomes a grant, so no one loses access.
INSERT INTO "user_role_grants" ("user_id", "role", "source")
SELECT "id", "role", 'BACKFILL' FROM "users" WHERE "role" <> 'CUSTOMER' AND "deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A rider who also runs a shop or society keeps that role as a grant too.
INSERT INTO "user_role_grants" ("user_id", "role", "source")
SELECT DISTINCT dp."user_id", 'DELIVERY_PARTNER'::"user_role", 'BACKFILL' FROM "delivery_partners" dp
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_role_grants" ("user_id", "role", "source")
SELECT DISTINCT s."owner_id", 'SHOP_OWNER'::"user_role", 'BACKFILL' FROM "shops" s WHERE s."deleted_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- KPI-013: riders online right now get an open session.
INSERT INTO "delivery_partner_sessions" ("delivery_partner_id", "started_at")
SELECT "id", COALESCE("last_location_at", now()) FROM "delivery_partners" WHERE "is_online" = true;
