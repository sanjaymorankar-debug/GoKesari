-- Onboarding Phase 2, Waves 2 and 3 (owner brief 23-Nov-2026; docs/onboarding-waves-2-3-2026-11/,
-- docs/onboarding-benchmark/phase-2/screens-flow-and-implementation-plan.md WP6, WP7, WP10).
--
-- * shop_registration_drafts + assisted_by_user_id, assisted_role, assisted_session_id (WP7, one assisted mode):
--   who filled in the wizard for the owner under a valid owner-consent session. NULL = the owner alone (every
--   existing row). No foreign keys (users and the consent-session tables are checked in the service).
-- * feature flags onboarding_referral_by_pin_enabled (WP6), onboarding_assisted_mode_enabled (WP7),
--   onboarding_scan_first_enabled (WP10), all OFF.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0192.sql (drops the three columns, their index and
-- check, and the three flag rows; run only after deploying code without them).
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "assisted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "assisted_role" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "assisted_session_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shop_registration_drafts_assisted_role') THEN
    ALTER TABLE "shop_registration_drafts" ADD CONSTRAINT "shop_registration_drafts_assisted_role"
      CHECK ("assisted_role" IS NULL OR "assisted_role" in ('DEALER', 'DEALER_EMPLOYEE', 'OPERATOR'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_drafts_assisted_idx" ON "shop_registration_drafts" ("assisted_by_user_id", "updated_at") WHERE "assisted_by_user_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('onboarding_referral_by_pin_enabled', false) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('onboarding_assisted_mode_enabled', false) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('onboarding_scan_first_enabled', false) ON CONFLICT DO NOTHING;
