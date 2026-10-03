ALTER TABLE "login_otps" ALTER COLUMN "phone_e164" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_otps" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "login_otps_email_created_idx" ON "login_otps" USING btree ("email","created_at");