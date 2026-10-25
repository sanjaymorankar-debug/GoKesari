-- split: core
-- D-25 (owner, 25 Oct 2026): a rewarded customer referral later found fraudulent
-- can be reversed. The rewards are taken back from the two wallets as REVERSAL
-- entries (never below zero; what could not be recovered is recorded), and the
-- friend's mobile number stays used: it cannot earn a referral reward again.
ALTER TABLE "customer_referrals" ADD COLUMN IF NOT EXISTS "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD COLUMN IF NOT EXISTS "reversed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD COLUMN IF NOT EXISTS "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD COLUMN IF NOT EXISTS "referrer_recovered_paise" bigint;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD COLUMN IF NOT EXISTS "referee_recovered_paise" bigint;--> statement-breakpoint
DROP INDEX IF EXISTS "customer_referrals_rewarded_phone_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_rewarded_phone_uq" ON "customer_referrals" USING btree ("referee_phone_e164") WHERE "customer_referrals"."status" IN ('REWARDED', 'REVERSED') AND "customer_referrals"."referee_phone_e164" IS NOT NULL;
