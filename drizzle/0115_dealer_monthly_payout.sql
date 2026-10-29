-- split: seller
-- Dealer commission paid monthly (owner, 28 Oct 2026; docs/dealer-programme): on the payout day
-- (default the 5th, IST) the previous calendar month is closed once — a draft payout per dealer
-- with every approved entry up to the month's end, netted with unsettled reversals — and each
-- dealer gets that month's statement (registrations brought, milestones earned, held, reversed,
-- paid, carried forward). The bank transfer stays an admin's step (its UTR recorded as today).
-- dealer_commission_months: one row per closed month (the guard that makes the close run once).
-- closed_by is a platform user: no foreign key across the split.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0115.sql
ALTER TABLE "dealer_commission_settings" ADD COLUMN IF NOT EXISTS "payout_day_of_month" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD COLUMN IF NOT EXISTS "auto_approve_at_month_end" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Staging ran an earlier copy of this migration (Hostinger preview build): the column may already exist, so set its default again.
ALTER TABLE "dealer_commission_settings" ALTER COLUMN "auto_approve_at_month_end" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" DROP CONSTRAINT IF EXISTS "dealer_commission_settings_payout_day";--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD CONSTRAINT "dealer_commission_settings_payout_day" CHECK ("payout_day_of_month" BETWEEN 1 AND 28);--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "period_month" text;--> statement-breakpoint
-- A payout drafted by the scheduled job has no admin as its creator.
ALTER TABLE "dealer_payout_batches" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_period_idx" ON "dealer_payout_batches" ("period_month") WHERE "period_month" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_commission_months" (
	"period_month" text PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"auto_approved" integer DEFAULT 0 NOT NULL,
	"payouts" integer DEFAULT 0 NOT NULL,
	"total_paise" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "dealer_commission_months_period" CHECK ("period_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
