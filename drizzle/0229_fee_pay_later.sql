-- Registration fee "Pay later" (docs/fee-pay-later-2026-11; owner request 28-Nov-2026). Additive only.
-- The owner asks to pay the shop registration fee later; an administrator approves; the shop goes live unpaid,
-- gets the weekly fee reminder, and the fee is taken out of the shop's payouts until it is paid in full.
-- Rollback: scripts/rollback-0229-fee-pay-later.sql.

-- 1. A pay-later request (one open request per registration draft / per shop).
CREATE TABLE IF NOT EXISTS "shop_fee_pay_later" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL,
  "draft_id" uuid,
  "shop_id" uuid,
  -- The fee owed when it was asked for (GST included), in paise.
  "amount_paise" bigint NOT NULL CHECK ("amount_paise" > 0),
  "status" text NOT NULL DEFAULT 'REQUESTED' CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','CANCELLED','SETTLED')),
  "owner_note" text,
  -- Who decides (owner, 28-Nov-2026): the dealer / franchise whose referral code the shop registered with; no such
  -- code (or that dealer is no longer active) → GoKesari's administrators.
  "referral_code" text,
  "approver_dealer_id" uuid,
  "approver_user_id" uuid,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone,
  "decided_by" uuid,
  "decision_note" text,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CHECK ("draft_id" IS NOT NULL OR "shop_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_fee_pay_later_open_draft_uq" ON "shop_fee_pay_later" ("draft_id") WHERE "status" IN ('REQUESTED','APPROVED') AND "draft_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_fee_pay_later_open_shop_uq" ON "shop_fee_pay_later" ("shop_id") WHERE "status" IN ('REQUESTED','APPROVED') AND "shop_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_fee_pay_later_status_idx" ON "shop_fee_pay_later" ("status", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_fee_pay_later_approver_idx" ON "shop_fee_pay_later" ("approver_user_id", "status") WHERE "approver_user_id" IS NOT NULL;
--> statement-breakpoint

-- 2. Each amount taken out of a payout for the fee (one row per payout cycle / weekly settlement and shop).
CREATE TABLE IF NOT EXISTS "shop_fee_recoveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pay_later_id" uuid NOT NULL REFERENCES "shop_fee_pay_later" ("id") ON DELETE RESTRICT,
  "shop_id" uuid NOT NULL,
  "amount_paise" bigint NOT NULL CHECK ("amount_paise" > 0),
  -- The payout before the deduction, for the owner's statement.
  "payout_before_paise" bigint NOT NULL,
  "source_type" text NOT NULL CHECK ("source_type" IN ('PAYOUT_CYCLE','SHOP_SETTLEMENT')),
  "source_id" uuid NOT NULL,
  "shop_payment_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE ("source_type", "source_id", "shop_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_fee_recoveries_shop_idx" ON "shop_fee_recoveries" ("shop_id", "created_at");
--> statement-breakpoint

-- 3. The draft passed the fee step by asking to pay later (onboarding v2).
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "fee_deferred_at" timestamp with time zone;
--> statement-breakpoint

-- 4. A fee payment taken out of a payout, on the shop's fee ledger. Added as 0209 adds enum values (nothing here uses it,
--    so it is safe inside the migrator's transaction).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'shop_payment_method' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."shop_payment_method" ADD VALUE IF NOT EXISTS ''PAYOUT_DEDUCTION''';
  END IF;
END $$;
--> statement-breakpoint

-- 5. A shop whose fee an administrator let it pay later goes live straight from PAYMENT_PENDING (documents verified,
--    fee owed). The application still refuses that approval for any other unpaid shop (assertRegistrationFeeSettled).
INSERT INTO "status_transition_rules" ("entity_type","from_status","to_status")
SELECT 'SHOP','PAYMENT_PENDING','ACTIVE'
WHERE NOT EXISTS (SELECT 1 FROM "status_transition_rules" WHERE "entity_type" = 'SHOP' AND "from_status" = 'PAYMENT_PENDING' AND "to_status" = 'ACTIVE');
--> statement-breakpoint

-- 6. Flag: ON on the staging database, OFF on production until the owner switches it on.
INSERT INTO "feature_flags" ("key", "enabled") VALUES
  ('shop_fee_pay_later_enabled', current_database() = 'gokesari_test')
ON CONFLICT DO NOTHING;
