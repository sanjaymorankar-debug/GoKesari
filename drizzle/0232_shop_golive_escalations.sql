-- Shop go-live rule for onboarding v2 / v3 registrations + one support escalation ladder (owner, 28-Nov-2026 ~12.00 IST;
-- docs/onboarding-v2-2026-11/README.md "Go-live rule and escalations"). Additive only. Rollback:
-- scripts/rollback-0232-shop-golive-escalations.sql.
--
-- A v2 / v3 registration goes live on: referral code, GST or PAN verified online, every term accepted, the fee paid
-- through the gateway (or pay-later approved). It is held only when another owner's shop has the same GSTIN or PAN
-- (kind SHOP_REVIEW below). A weak name match or a PAN that is not the one inside the GSTIN no longer holds it: it is
-- a review flag (shop_review_flags) for admin / operator after go-live.
--
-- Escalation ladder (rule supportEscalation): day 0 the franchisee behind the shop's referral code; not closed in
-- franchiseeDays (7) → the operator queue; in adminDays (10) → the admin team. Kinds:
--   SHOP_REVIEW           a held v2 / v3 shop (subject = the shop)
--   FEE_PAY_LATER         a pay-later request waiting for a decision (subject = shop_fee_pay_later.id)
--   NO_PRODUCTS_OR_SALES  a v2 / v3 shop live for noSalesAfterDays (10) with no product listed or no sale yet
--                         (subject = the shop)
-- No foreign keys to the seller / customer tables (the project rule): the service checks the links.

-- 1. One escalation per subject while it is open.
CREATE TABLE IF NOT EXISTS "support_escalations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('SHOP_REVIEW','FEE_PAY_LATER','NO_PRODUCTS_OR_SALES')),
  "subject_id" uuid NOT NULL,
  "shop_id" uuid,
  "owner_id" uuid,
  "level" text NOT NULL CHECK ("level" IN ('FRANCHISEE','OPERATOR','ADMIN')),
  -- The franchisee (free dealer / franchisee of the referral code, or the franchisee above a team member); null when
  -- the shop has none (it then starts at OPERATOR).
  "franchisee_dealer_id" uuid,
  "franchisee_user_id" uuid,
  "reason" text,
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "level_changed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_reminded_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  -- APPROVED / REJECTED (a decision), RESOLVED (the condition cleared: products + a sale, decided elsewhere), CLOSED (staff).
  "resolution" text CHECK ("resolution" IS NULL OR "resolution" IN ('APPROVED','REJECTED','RESOLVED','CLOSED')),
  "resolution_note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_escalations_open_uq" ON "support_escalations" ("kind", "subject_id") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_escalations_level_idx" ON "support_escalations" ("level", "opened_at") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_escalations_franchisee_idx" ON "support_escalations" ("franchisee_user_id") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_escalations_shop_idx" ON "support_escalations" ("shop_id", "kind");
--> statement-breakpoint

-- 2. Every hand-over: opened, moved up a level, reminded, closed — who had it, when it moved, who closed it.
CREATE TABLE IF NOT EXISTS "support_escalation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "escalation_id" uuid NOT NULL REFERENCES "support_escalations" ("id") ON DELETE CASCADE,
  "event" text NOT NULL CHECK ("event" IN ('OPENED','ESCALATED','REMINDED','RESOLVED')),
  "from_level" text,
  "to_level" text,
  "actor_id" uuid,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_escalation_events_escalation_idx" ON "support_escalation_events" ("escalation_id", "created_at");
--> statement-breakpoint

-- 3. Things to look at after go-live (never a hold): a weak GST / PAN name match, a PAN not the one inside the GSTIN.
CREATE TABLE IF NOT EXISTS "shop_review_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL,
  "flag" text NOT NULL CHECK ("flag" IN ('NAME_MATCH_LOW','NAME_NOT_RETURNED','PAN_NOT_IN_GSTIN')),
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid,
  "resolution_note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_review_flags_open_uq" ON "shop_review_flags" ("shop_id", "flag") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_review_flags_open_idx" ON "shop_review_flags" ("created_at") WHERE "resolved_at" IS NULL;
