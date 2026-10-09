-- 0067 Referral code at customer registration (docs/four-features-2026-10,
-- decided by the owner on 9 Oct 2026): the code a customer gave when they
-- joined — one GoKesari issued, or a friend's. Additive only (one new table).
-- Rollback: scripts/rollback-0067.sql.
CREATE TABLE "customer_signup_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"referral_code_id" uuid,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_signup_referrals_kind" CHECK ("customer_signup_referrals"."kind" <> 'GOKESARI' OR "customer_signup_referrals"."referral_code_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "customer_signup_referrals" ADD CONSTRAINT "customer_signup_referrals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signup_referrals" ADD CONSTRAINT "customer_signup_referrals_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_signup_referrals_user_uq" ON "customer_signup_referrals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "customer_signup_referrals_code_idx" ON "customer_signup_referrals" USING btree ("referral_code_id","created_at");