-- 0068 Customer referral-code requests (docs/four-features-2026-10, the owner's
-- decision of 9 Oct 2026: a referral code is mandatory for customers; one
-- without a code asks for it with their location, PIN code, city and contact
-- number). Additive only (one new table). Rollback: scripts/rollback-0068.sql.
CREATE TABLE "customer_referral_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mobile_e164" text NOT NULL,
	"city" text NOT NULL,
	"pincode" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"location_accuracy_m" integer,
	"maps_url" text,
	"location_status" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"issued_code_id" uuid,
	"issued_code" text,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"email_status" text,
	"email_error" text,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_referral_requests_pincode" CHECK ("customer_referral_requests"."pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "customer_referral_requests" ADD CONSTRAINT "customer_referral_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referral_requests" ADD CONSTRAINT "customer_referral_requests_issued_code_id_referral_codes_id_fk" FOREIGN KEY ("issued_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referral_requests" ADD CONSTRAINT "customer_referral_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_referral_requests_user_idx" ON "customer_referral_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_referral_requests_mobile_idx" ON "customer_referral_requests" USING btree ("mobile_e164","created_at");--> statement-breakpoint
CREATE INDEX "customer_referral_requests_status_idx" ON "customer_referral_requests" USING btree ("status","created_at");