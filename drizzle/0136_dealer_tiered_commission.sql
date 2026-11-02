-- split: seller
-- Owner brief, 2 Nov 2026 (docs/dealer-programme/TIERED_COMMISSION.md): a 3-level dealer
-- network (MAIN_DEALER → TEAM_LEAD → AGENT) earning a TIERED commission on the registration fee
-- actually paid (before GST, after any coupon): direct 20% (60% at ACTIVATED, 40% at TRADING),
-- team-lead override 5% and main-dealer override 3% (at TRADING), renewal commission, a
-- development bonus after a promotion and monthly target bonuses — every value from rule
-- dealerTieredCommission, off by default. Existing dealers stay on the standard model
-- (commission_model STANDARD) until an admin moves each one; accrued commission is never
-- recalculated. A fourth level is refused here, by the composite foreign key and checks on
-- dealer_salespeople. Safe to rerun. Rollback: scripts/rollback-0136.sql.

-- 1. Dealers: the model and their own TIERED rates, the agent agreement.
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "commission_model" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "tier_direct_bp" integer;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "tier_lead_override_bp" integer;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "tier_main_override_bp" integer;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "tier_agreement_version" text;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "tier_agreement_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_commission_model";--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_commission_model" CHECK ("commission_model" in ('STANDARD', 'TIERED'));--> statement-breakpoint
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_tier_percents";--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_tier_percents" CHECK (("tier_direct_bp" IS NULL OR "tier_direct_bp" BETWEEN 0 AND 10000) AND ("tier_lead_override_bp" IS NULL OR "tier_lead_override_bp" BETWEEN 0 AND 10000) AND ("tier_main_override_bp" IS NULL OR "tier_main_override_bp" BETWEEN 0 AND 10000));--> statement-breakpoint

-- 2. Team members: role, level, parent (max 3 levels), who recruited them, payee details.
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "team_role" text DEFAULT 'AGENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "depth" smallint DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "parent_depth" smallint;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "parent_role" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "recruited_by_id" uuid;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "pan_enc" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "pan_hash" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "pan_last4" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_holder_name" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_account_enc" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_account_last4" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_status" text DEFAULT 'NOT_PROVIDED' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_status_reason" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "bank_check_ref" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "agreement_version" text;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD COLUMN IF NOT EXISTS "agreement_accepted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_salespeople_level_key" ON "dealer_salespeople" ("dealer_id", "id", "depth", "team_role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_salespeople_dealer_key" ON "dealer_salespeople" ("dealer_id", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_salespeople_parent_idx" ON "dealer_salespeople" ("parent_id") WHERE "parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_salespeople_user_idx" ON "dealer_salespeople" ("user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_parent_fk";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_parent_fk" FOREIGN KEY ("dealer_id", "parent_id", "parent_depth", "parent_role") REFERENCES "dealer_salespeople" ("dealer_id", "id", "depth", "team_role");--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_recruiter_fk";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_recruiter_fk" FOREIGN KEY ("dealer_id", "recruited_by_id") REFERENCES "dealer_salespeople" ("dealer_id", "id");--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_role";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_role" CHECK ("team_role" in ('TEAM_LEAD', 'AGENT'));--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_depth";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_depth" CHECK ("depth" in (2, 3));--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_parent_shape";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_parent_shape" CHECK (("parent_id" IS NULL AND "parent_depth" IS NULL AND "parent_role" IS NULL AND "depth" = 2) OR ("parent_id" IS NOT NULL AND "parent_depth" = "depth" - 1 AND "parent_role" = 'TEAM_LEAD' AND "depth" = 3));--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_lead_depth";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_lead_depth" CHECK ("team_role" <> 'TEAM_LEAD' OR "depth" = 2);--> statement-breakpoint
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_bank_status";--> statement-breakpoint
ALTER TABLE "dealer_salespeople" ADD CONSTRAINT "dealer_salespeople_bank_status" CHECK ("bank_status" in ('NOT_PROVIDED', 'PENDING', 'VERIFIED', 'FAILED'));--> statement-breakpoint

-- 3. The ledger: entry type, payee, level and an accrual key (several accruals per shop now).
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "entry_type" text DEFAULT 'BASE' NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "payee_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "level" smallint;--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "accrual_key" text;--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ALTER COLUMN "shop_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_milestone";--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_milestone" CHECK ("milestone" in ('REGISTERED', 'VERIFIED_CATALOGUE', 'ACTIVATED', 'TRADING', 'RENEWAL', 'MONTHLY'));--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_entry_type";--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_entry_type" CHECK ("entry_type" in ('BASE', 'DIRECT_1', 'DIRECT_2', 'OVERRIDE_LEAD', 'OVERRIDE_MAIN', 'RENEWAL', 'DEVELOPMENT', 'BONUS'));--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_shop";--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_shop" CHECK ("shop_id" IS NOT NULL OR "entry_type" = 'BONUS');--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_level";--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_level" CHECK ("level" IS NULL OR "level" in (1, 2, 3));--> statement-breakpoint
-- The old key (shop, milestone, above_cap) still holds for BASE accruals (accrual_key null).
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_ledger_accrual_key_unique" ON "dealer_commission_ledger" ((coalesce("accrual_key", 'BASE:' || "shop_id"::text || ':' || "milestone")), "above_cap") WHERE "kind" = 'ACCRUAL';--> statement-breakpoint
DROP INDEX IF EXISTS "dealer_commission_ledger_accrual_unique";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_payee_idx" ON "dealer_commission_ledger" ("payee_member_id") WHERE "payee_member_id" IS NOT NULL;--> statement-breakpoint

-- 4. Payouts: one per payee (a team member is paid directly), with TDS.
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_member_idx" ON "dealer_payout_batches" ("member_id") WHERE "member_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" DROP CONSTRAINT IF EXISTS "dealer_payout_batches_tds";--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD CONSTRAINT "dealer_payout_batches_tds" CHECK ("tds_paise" >= 0 AND "tds_paise" <= greatest("total_paise", 0) AND "tds_rate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint

-- 5. The per-shop plan (who earns what, TRADING progress), development bonuses, sub-agent requests.
CREATE TABLE IF NOT EXISTS "dealer_tier_shop_plans" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"direct_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"direct_level" smallint NOT NULL,
	"lead_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"main_override" boolean NOT NULL,
	"development_id" uuid,
	"development_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"fee_paise" integer NOT NULL,
	"direct_bp" integer NOT NULL,
	"rating_adjustment_bp" integer DEFAULT 0 NOT NULL,
	"first_part_bp" integer NOT NULL,
	"lead_override_bp" integer NOT NULL,
	"main_override_bp" integer NOT NULL,
	"development_bp" integer DEFAULT 0 NOT NULL,
	"trading_orders" integer NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"trading_deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"delivered_orders" integer DEFAULT 0 NOT NULL,
	"trading_at" timestamp with time zone,
	"lapsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_tier_shop_plans_status" CHECK ("status" in ('PENDING', 'TRADING', 'LAPSED', 'REVERSED')),
	CONSTRAINT "dealer_tier_shop_plans_level" CHECK ("direct_level" in (1, 2, 3))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_tier_shop_plans_dealer_idx" ON "dealer_tier_shop_plans" ("dealer_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_tier_shop_plans_deadline_idx" ON "dealer_tier_shop_plans" ("trading_deadline") WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_team_developments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"beneficiary_member_id" uuid NOT NULL REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"team_lead_member_id" uuid NOT NULL REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"bp" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_team_developments_bp" CHECK ("bp" BETWEEN 0 AND 10000),
	CONSTRAINT "dealer_team_developments_window" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "dealer_team_developments_people" CHECK ("beneficiary_member_id" <> "team_lead_member_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_team_developments_lead_idx" ON "dealer_team_developments" ("team_lead_member_id", "ends_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_team_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"requested_by_member_id" uuid NOT NULL REFERENCES "dealer_salespeople"("id") ON DELETE RESTRICT,
	"employee_id" text NOT NULL,
	"name" text NOT NULL,
	"mobile_e164" text,
	"note" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_team_requests_status" CHECK ("status" in ('PENDING', 'APPROVED', 'REJECTED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_team_requests_status_idx" ON "dealer_team_requests" ("status", "created_at");
