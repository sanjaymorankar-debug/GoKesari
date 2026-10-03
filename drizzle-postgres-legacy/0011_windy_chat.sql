CREATE TYPE "public"."delivery_partner_status" AS ENUM('REGISTERED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DEACTIVATED');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'DELIVERY_PARTNER';--> statement-breakpoint
CREATE TABLE "delivery_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text,
	"date_of_birth" date,
	"profile_photo_url" text,
	"pan_number" text,
	"government_id_type" text,
	"government_id_number" text,
	"bank_account_holder_name" text,
	"bank_account_number" text,
	"bank_ifsc" text,
	"vehicle_type" text NOT NULL,
	"vehicle_registration_number" text,
	"driving_licence_number" text,
	"latitude" text,
	"longitude" text,
	"operating_radius_km" integer DEFAULT 5 NOT NULL,
	"location_verified" boolean DEFAULT false NOT NULL,
	"location_verified_at" timestamp with time zone,
	"location_source" text,
	"status" "delivery_partner_status" DEFAULT 'REGISTERED' NOT NULL,
	"review_notes" text,
	"rejection_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD CONSTRAINT "delivery_partners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD CONSTRAINT "delivery_partners_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_partners_user_id_unique" ON "delivery_partners" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "delivery_partners_status_idx" ON "delivery_partners" USING btree ("status");