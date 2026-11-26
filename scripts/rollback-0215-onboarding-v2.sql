-- Rollback of drizzle/0215_onboarding_v2.sql (docs/onboarding-v2-2026-11).
-- Switch the flag off first (Admin → Feature flags → onboarding_v2); with it off nothing reads these tables.
-- Wallets created by the backfill are kept (they are ordinary empty customer wallets).
UPDATE "feature_flags" SET "enabled" = false WHERE "key" = 'onboarding_v2';
DROP TABLE IF EXISTS "registration_licence_entries";
DROP TABLE IF EXISTS "team_invitations";
DROP TABLE IF EXISTS "onboarding_role_history";
ALTER TABLE "franchise_bookings" DROP COLUMN IF EXISTS "plan_id";
DROP TABLE IF EXISTS "franchise_plans";
ALTER TABLE "shop_registration_drafts"
  DROP COLUMN IF EXISTS "flow_version",
  DROP COLUMN IF EXISTS "identity_verified_at",
  DROP COLUMN IF EXISTS "fee_kind",
  DROP COLUMN IF EXISTS "fee_paise",
  DROP COLUMN IF EXISTS "fee_payment_intent_id",
  DROP COLUMN IF EXISTS "fee_paid_at",
  DROP COLUMN IF EXISTS "sla_accepted_at";
