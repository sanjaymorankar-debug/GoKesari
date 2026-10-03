-- Add profile completion fields to users table
ALTER TABLE "users" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_completed_at" timestamp with time zone;--> statement-breakpoint
-- Support email-based OTP login (not just mobile)
ALTER TABLE "login_otps" ADD COLUMN "email" text;--> statement-breakpoint
-- Add index for email-based OTP lookups (matches the phoneE164 index pattern)
CREATE INDEX "login_otps_email_created_idx" ON "login_otps" USING btree ("email", "created_at");--> statement-breakpoint
-- Remove NOT NULL constraint from phoneE164 to allow email-only login
ALTER TABLE "login_otps" ALTER COLUMN "phone_e164" DROP NOT NULL;
