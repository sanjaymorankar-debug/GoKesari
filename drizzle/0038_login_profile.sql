-- Login by mobile or email (codes always emailed) and first-time profile details.
-- Additive only and safe to re-run: existing rows keep working, nothing is dropped.
--
-- Numbered 0037 on staging until it was merged with main's 0037_dispute_cases.
-- The test database already ran it under that number, and drizzle will run it
-- again there under this one, so every statement must be a no-op the second
-- time — including the one-off profile backfill below.
ALTER TABLE "login_otps" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_otps" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "login_otps" ADD COLUMN IF NOT EXISTS "purpose" text DEFAULT 'LOGIN' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otps_email_created_idx" ON "login_otps" USING btree ("email","created_at");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "login_otps" ADD CONSTRAINT "login_otps_identifier_present" CHECK ("login_otps"."phone_e164" IS NOT NULL OR "login_otps"."email" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Accounts that already have a name and a mobile number are not asked for details again.
-- Everyone else (e.g. email-only wallet accounts) sees the details form on their next sign-in.
-- The backfill runs only in the run that adds the column: on a re-run it would also
-- mark accounts created since, which never saved the details form.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'users'
                    AND column_name = 'profile_completed_at') THEN
    ALTER TABLE "users" ADD COLUMN "profile_completed_at" timestamp with time zone;
    UPDATE "users" SET "profile_completed_at" = now()
     WHERE "name" IS NOT NULL AND "phone_e164" IS NOT NULL;
  END IF;
END $$;
