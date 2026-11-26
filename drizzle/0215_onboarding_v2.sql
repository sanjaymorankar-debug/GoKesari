-- Onboarding v2 (docs/onboarding-v2-2026-11; owner brief 26-Nov-2026 18.19 IST). Flag `onboarding_v2`.
--
-- * onboarding_role_history, team_invitations, franchise_plans, registration_licence_entries (new tables).
-- * shop_registration_drafts: v2 progress columns (identity verified, fee kind / payment, SLA accepted).
-- * franchise_bookings.plan_id: the subscription plan a paid franchise booking was bought on.
-- * franchise_plans seeded with the 1-year launch offer (₹1,50,000 + GST per zone).
-- * Feature flag onboarding_v2: ON on the staging database (gokesari_test), OFF everywhere else
--   (production is switched on only after its own test pass).
-- * Data: every shop owner without a customer wallet gets one; existing shop owners, dealers, franchisees and
--   team members get a MIGRATED row in onboarding_role_history so the role list starts complete. Pending shop
--   registrations are not touched.
--
-- Additive and safe to re-run. Nothing is dropped. Rollback: scripts/rollback-0215-onboarding-v2.sql.
CREATE TABLE IF NOT EXISTS "onboarding_role_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "action" text NOT NULL,
  "from_value" text,
  "to_value" text,
  "dealer_id" uuid,
  "salesperson_id" uuid,
  "actor_user_id" uuid,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "onboarding_role_history_role" CHECK ("role" IN ('customer','shop_owner','dealer_free','franchisee_paid','team_lead','agent','admin','operator')),
  CONSTRAINT "onboarding_role_history_action" CHECK ("action" IN ('GRANTED','REVOKED','UPGRADED','DOWNGRADED','REASSIGNED','MIGRATED','OVERRIDE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_role_history_user_idx" ON "onboarding_role_history" ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_role_history_dealer_idx" ON "onboarding_role_history" ("dealer_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL,
  "invited_by_user_id" uuid NOT NULL,
  "invited_by_salesperson_id" uuid,
  "invitee_user_id" uuid,
  "invitee_mobile_e164" text,
  "invitee_email" text,
  "role" text NOT NULL,
  "parent_salesperson_id" uuid,
  "token_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "channels" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "decided_at" timestamptz,
  "salesperson_id" uuid,
  CONSTRAINT "team_invitations_role" CHECK ("role" IN ('TEAM_LEAD','AGENT')),
  CONSTRAINT "team_invitations_status" CHECK ("status" IN ('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED')),
  CONSTRAINT "team_invitations_contact" CHECK ("invitee_user_id" IS NOT NULL OR "invitee_mobile_e164" IS NOT NULL OR "invitee_email" IS NOT NULL),
  CONSTRAINT "team_invitations_lead_has_no_parent" CHECK ("role" = 'AGENT' OR "parent_salesperson_id" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_invitations_token_unique" ON "team_invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_dealer_idx" ON "team_invitations" ("dealer_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_invitee_idx" ON "team_invitations" ("invitee_user_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "duration_months" integer NOT NULL DEFAULT 12,
  "price_per_zone_paise" integer,
  "gst_extra" boolean NOT NULL DEFAULT true,
  "is_launch_offer" boolean NOT NULL DEFAULT false,
  "active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid,
  CONSTRAINT "franchise_plans_duration" CHECK ("duration_months" BETWEEN 1 AND 120),
  CONSTRAINT "franchise_plans_price" CHECK ("price_per_zone_paise" IS NULL OR "price_per_zone_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_plans_code_unique" ON "franchise_plans" ("code");
--> statement-breakpoint
-- DEFAULT – confirm with Sanjay ("Defaults chosen" #4): one seeded plan, the 1-year launch offer at ₹1,50,000 + GST per zone.
INSERT INTO "franchise_plans" ("code", "name", "description", "duration_months", "price_per_zone_paise", "gst_extra", "is_launch_offer", "active", "sort_order")
VALUES ('LAUNCH_1Y', '1-year launch offer', 'Launch offer: ₹1,50,000 + GST per zone for 1 year. After the launch offer the zone''s tier price applies.', 12, 15000000, true, true, true, 0)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "franchise_bookings" ADD COLUMN IF NOT EXISTS "plan_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registration_licence_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "shop_id" uuid,
  "licence_key" text NOT NULL,
  "option" text NOT NULL,
  "licence_number" text,
  "holder_name" text,
  "valid_until" text,
  "issuing_authority" text,
  "file_ref" text,
  "ocr" jsonb,
  "status" text NOT NULL,
  "status_reason" text,
  "promise_accepted_at" timestamptz,
  "verified_at" timestamptz,
  "verify_ref" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "registration_licence_entries_option" CHECK ("option" IN ('ENTER','UPLOAD','SCAN','LATER')),
  CONSTRAINT "registration_licence_entries_status" CHECK ("status" IN ('VERIFIED','PENDING_OPERATOR','PROMISED','REJECTED')),
  CONSTRAINT "registration_licence_entries_promise" CHECK ("option" <> 'LATER' OR "promise_accepted_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registration_licence_entries_draft_key_unique" ON "registration_licence_entries" ("draft_id", "licence_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_licence_entries_shop_idx" ON "registration_licence_entries" ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_licence_entries_status_idx" ON "registration_licence_entries" ("status");
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "flow_version" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "identity_verified_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "fee_kind" text;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "fee_paise" integer;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "fee_payment_intent_id" uuid;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "fee_paid_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "sla_accepted_at" timestamptz;
--> statement-breakpoint
-- Flag: ON for the staging database only (brief: "on by default on Test"); production stays OFF.
INSERT INTO "feature_flags" ("key", "enabled")
VALUES ('onboarding_v2', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Every shop owner has a customer wallet (brief: "existing shop owners with no customer account get one, plus a wallet").
-- Shop owners already sign in with a customer account (users row), so only the wallet can be missing.
INSERT INTO "wallets" ("user_id")
SELECT DISTINCT s."owner_id"
FROM "shops" s
WHERE s."owner_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "wallets" w WHERE w."user_id" = s."owner_id");
--> statement-breakpoint
-- Starting role list (MIGRATED rows, once per user and role).
INSERT INTO "onboarding_role_history" ("user_id", "role", "action", "reason")
SELECT DISTINCT s."owner_id", 'shop_owner', 'MIGRATED', '0215: existing shop owner'
FROM "shops" s
WHERE s."owner_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "onboarding_role_history" h WHERE h."user_id" = s."owner_id" AND h."role" = 'shop_owner');
--> statement-breakpoint
INSERT INTO "onboarding_role_history" ("user_id", "role", "action", "dealer_id", "reason")
SELECT d."user_id",
       CASE WHEN EXISTS (SELECT 1 FROM "franchise_allocations" a WHERE a."owner_dealer_id" = d."id" AND a."status" IN ('ACTIVE','SUSPENDED','EXPIRED'))
            THEN 'franchisee_paid' ELSE 'dealer_free' END,
       'MIGRATED', d."id", '0215: existing dealer / franchise booking'
FROM "dealers" d
WHERE d."user_id" IS NOT NULL AND d."status" IN ('APPROVED','SUSPENDED')
  AND NOT EXISTS (SELECT 1 FROM "onboarding_role_history" h WHERE h."user_id" = d."user_id" AND h."role" IN ('dealer_free','franchisee_paid'));
--> statement-breakpoint
INSERT INTO "onboarding_role_history" ("user_id", "role", "action", "dealer_id", "salesperson_id", "reason")
SELECT sp."user_id", CASE WHEN sp."team_role" = 'TEAM_LEAD' THEN 'team_lead' ELSE 'agent' END,
       'MIGRATED', sp."dealer_id", sp."id", '0215: existing dealer team member'
FROM "dealer_salespeople" sp
WHERE sp."user_id" IS NOT NULL AND sp."status" = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM "onboarding_role_history" h WHERE h."salesperson_id" = sp."id");
