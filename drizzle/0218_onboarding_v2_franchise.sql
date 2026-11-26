-- Onboarding v2, Flow 3 — franchise (docs/onboarding-v2-2026-11). Flag `onboarding_v2`.
--
-- * franchise_bookings: a snapshot of the subscription plan taken when the zones are reserved — its code, term
--   (months) and price per zone (paise, before GST; NULL = the zone's tier fee). The payment capture uses the
--   snapshot, so an admin editing the plan between reserve and payment never changes what the buyer agreed to.
--   NULL on every existing row (bookings without a plan), so with the flag off nothing changes.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0218-onboarding-v2-franchise.sql.
ALTER TABLE "franchise_bookings" ADD COLUMN IF NOT EXISTS "plan_code" text;
--> statement-breakpoint
ALTER TABLE "franchise_bookings" ADD COLUMN IF NOT EXISTS "plan_duration_months" integer;
--> statement-breakpoint
ALTER TABLE "franchise_bookings" ADD COLUMN IF NOT EXISTS "plan_price_per_zone_paise" bigint;
