-- split: seller
-- Owner decision, 29 Oct 2026 (dealer commission): an admin sets a base
-- commission as a % of the registration fee paid (before GST, after any
-- coupon), earned in full when the shop is approved. Each rating point above
-- or below 5.0 moves it up or down by the same step (1 percentage point by
-- default). Both the base % and the step can be set for one dealer. The fixed
-- amounts per milestone are no longer used (commission_model BASE_PERCENT);
-- the milestone rules stay for their history and can be switched back to.
-- Safe to rerun.
ALTER TABLE "dealer_commission_settings" ADD COLUMN IF NOT EXISTS "commission_model" text DEFAULT 'BASE_PERCENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD COLUMN IF NOT EXISTS "base_percent_bp" integer DEFAULT 4000 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD COLUMN IF NOT EXISTS "rating_step_bp" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" DROP CONSTRAINT IF EXISTS "dealer_commission_settings_model";--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD CONSTRAINT "dealer_commission_settings_model" CHECK ("commission_model" in ('BASE_PERCENT', 'MILESTONE_RULES'));--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" DROP CONSTRAINT IF EXISTS "dealer_commission_settings_base_percent";--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD CONSTRAINT "dealer_commission_settings_base_percent" CHECK ("base_percent_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" DROP CONSTRAINT IF EXISTS "dealer_commission_settings_rating_step";--> statement-breakpoint
ALTER TABLE "dealer_commission_settings" ADD CONSTRAINT "dealer_commission_settings_rating_step" CHECK ("rating_step_bp" BETWEEN 0 AND 1000);--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "commission_percent_bp" integer;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "rating_step_bp" integer;--> statement-breakpoint
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_commission_percent";--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_commission_percent" CHECK ("commission_percent_bp" IS NULL OR "commission_percent_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_rating_step";--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_rating_step" CHECK ("rating_step_bp" IS NULL OR "rating_step_bp" BETWEEN 0 AND 1000);
