-- Login by mobile or email (codes always emailed) and first-time profile details.
-- Additive only and safe to re-run: existing rows keep working, nothing is dropped.
ALTER TABLE "login_otps" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_otps" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "login_otps" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'LOGIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "profile_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otps_email_created_idx" ON "login_otps" USING btree ("email","created_at");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "login_otps" ADD CONSTRAINT "login_otps_identifier_present" CHECK ("login_otps"."phone_e164" IS NOT NULL OR "login_otps"."email" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Accounts that already have a name and a mobile number are not asked for details again.
-- Everyone else (e.g. email-only wallet accounts) sees the details form on their next sign-in.
UPDATE "users" SET "profile_completed_at" = now()
WHERE "profile_completed_at" IS NULL AND "name" IS NOT NULL AND "phone_e164" IS NOT NULL;
