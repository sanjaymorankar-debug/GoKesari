-- 0064 Shop referral-code requests (docs/four-features-2026-10, feature 4): the
-- "Request a referral code" form on shop registration — requester, address,
-- browser location when shared, status (new / code issued / rejected) and
-- whether the referrals email went out. Additive only (one new table).
-- Rollback: scripts/rollback-0064.sql.
CREATE TABLE "referral_code_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"mobile_e164" text NOT NULL,
	"shop_type" text NOT NULL,
	"area" text NOT NULL,
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
	CONSTRAINT "referral_code_requests_pincode" CHECK ("referral_code_requests"."pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "referral_code_requests" ADD CONSTRAINT "referral_code_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_code_requests" ADD CONSTRAINT "referral_code_requests_issued_code_id_referral_codes_id_fk" FOREIGN KEY ("issued_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_code_requests" ADD CONSTRAINT "referral_code_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_code_requests_mobile_idx" ON "referral_code_requests" USING btree ("mobile_e164","created_at");--> statement-breakpoint
CREATE INDEX "referral_code_requests_status_idx" ON "referral_code_requests" USING btree ("status","created_at");