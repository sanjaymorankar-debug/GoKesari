CREATE TYPE "public"."consent_type" AS ENUM('TERMS_AND_PRIVACY', 'MARKETING_COMMUNICATIONS');--> statement-breakpoint
CREATE TYPE "public"."grievance_category" AS ENUM('PAYMENT', 'WALLET', 'ORDER', 'SUBSCRIPTION', 'SELLER', 'PRODUCT', 'PRIVACY', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."grievance_status" AS ENUM('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');--> statement-breakpoint
-- Allocates ticket_number defaults (GRV-000001…) — same pattern as
-- product_code_seq / shop_registration_seq elsewhere in this schema.
CREATE SEQUENCE IF NOT EXISTS "grievance_ticket_seq" AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint
CREATE TABLE "grievances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_number" text DEFAULT 'GRV-' || lpad(nextval('grievance_ticket_seq')::text, 6, '0') NOT NULL,
	"submitted_by_user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"category" "grievance_category" DEFAULT 'OTHER' NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"status" "grievance_status" DEFAULT 'OPEN' NOT NULL,
	"assigned_to_user_id" uuid,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"version" text NOT NULL,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "legal_business_name" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "fssai_license_number" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "return_policy_text" text;--> statement-breakpoint
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grievances_ticket_number_unique" ON "grievances" USING btree ("ticket_number");--> statement-breakpoint
CREATE INDEX "grievances_status_idx" ON "grievances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grievances_email_idx" ON "grievances" USING btree ("email");--> statement-breakpoint
CREATE INDEX "grievances_submitted_by_idx" ON "grievances" USING btree ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "user_consents_user_idx" ON "user_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_consents_type_idx" ON "user_consents" USING btree ("consent_type");