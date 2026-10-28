-- split: seller
-- Dealer programme step 5 (docs/dealer-programme, GKS-CM-001…003): commission rules (versioned,
-- admin only), the commission ledger, payout batches, the onboarding rating and its slabs.
-- ADDITIVE ONLY; idempotent. No money moves here: a payout batch records a bank transfer made
-- outside GoKesari, with its reference.
CREATE TABLE IF NOT EXISTS "dealer_commission_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" uuid NOT NULL,
	"version" integer NOT NULL,
	"shop_scope" text DEFAULT 'STANDARD' NOT NULL,
	"district_code" text,
	"milestone" text NOT NULL,
	"fixed_paise" integer DEFAULT 0 NOT NULL,
	"percent_bp" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"change_reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_commission_rules_scope" CHECK ("shop_scope" in ('STANDARD', 'WHOLESALE', 'ALL')),
	CONSTRAINT "dealer_commission_rules_milestone" CHECK ("milestone" in ('REGISTERED', 'VERIFIED_CATALOGUE', 'ACTIVATED')),
	CONSTRAINT "dealer_commission_rules_amounts" CHECK ("fixed_paise" >= 0 AND "percent_bp" BETWEEN 0 AND 10000 AND ("fixed_paise" > 0 OR "percent_bp" > 0)),
	CONSTRAINT "dealer_commission_rules_status" CHECK ("status" in ('ACTIVE', 'SUPERSEDED', 'DISABLED')),
	CONSTRAINT "dealer_commission_rules_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_rules_version_unique" ON "dealer_commission_rules" ("rule_key", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_rules_lookup_idx" ON "dealer_commission_rules" ("milestone", "status");--> statement-breakpoint
-- Pilot defaults (prompt 3.5): standard shop ₹100 / ₹150 / ₹150 = ₹400. Wholesale is set by the admin.
INSERT INTO "dealer_commission_rules" ("rule_key", "version", "shop_scope", "milestone", "fixed_paise", "effective_from", "change_reason")
SELECT gen_random_uuid(), 1, 'STANDARD', m.milestone, m.paise, DATE '2026-10-28', 'pilot default (build prompt 3.5)'
  FROM (VALUES ('REGISTERED', 10000), ('VERIFIED_CATALOGUE', 15000), ('ACTIVATED', 15000)) AS m(milestone, paise)
 WHERE NOT EXISTS (SELECT 1 FROM "dealer_commission_rules");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_commission_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"cap_paise" integer DEFAULT 99900 NOT NULL,
	"fixed_bonus_base" text DEFAULT 'FEE' NOT NULL,
	"catalogue_min_products" integer DEFAULT 10 NOT NULL,
	"branch_eligible" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_commission_settings_single" CHECK ("id" = 'default'),
	CONSTRAINT "dealer_commission_settings_cap" CHECK ("cap_paise" >= 0),
	CONSTRAINT "dealer_commission_settings_bonus_base" CHECK ("fixed_bonus_base" in ('FEE', 'BASE_AMOUNT')),
	CONSTRAINT "dealer_commission_settings_catalogue" CHECK ("catalogue_min_products" BETWEEN 1 AND 10000)
);--> statement-breakpoint
INSERT INTO "dealer_commission_settings" ("id") VALUES ('default') ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_rating_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_shops" integer NOT NULL,
	"rating" numeric(3, 1) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_rating_slabs_min" CHECK ("min_shops" >= 0),
	CONSTRAINT "dealer_rating_slabs_rating" CHECK ("rating" BETWEEN 0 AND 10 AND ("rating" * 2) = round("rating" * 2))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_rating_slabs_min_unique" ON "dealer_rating_slabs" ("min_shops");--> statement-breakpoint
INSERT INTO "dealer_rating_slabs" ("min_shops", "rating")
SELECT s.min_shops, s.rating FROM (VALUES (0, 5.0), (200, 5.5), (250, 6.0), (500, 6.5)) AS s(min_shops, rating)
 WHERE NOT EXISTS (SELECT 1 FROM "dealer_rating_slabs");--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "start_rating" numeric(3, 1) DEFAULT 5.0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "rating" numeric(3, 1) DEFAULT 5.0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "rating_override" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "rating_override_until_shops" integer;--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "activated_shops" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_attributions" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_rating_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"old_rating" numeric(3, 1) NOT NULL,
	"new_rating" numeric(3, 1) NOT NULL,
	"kind" text NOT NULL,
	"activated_shops" integer NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_rating_history_kind" CHECK ("kind" in ('AUTO', 'START', 'MANUAL'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_rating_history_dealer_idx" ON "dealer_rating_history" ("dealer_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_payout_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"total_paise" integer NOT NULL,
	"payment_reference" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_payout_batches_status" CHECK ("status" in ('DRAFT', 'PAID', 'CANCELLED')),
	CONSTRAINT "dealer_payout_batches_paid" CHECK ("status" <> 'PAID' OR ("payment_reference" IS NOT NULL AND "paid_at" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_dealer_idx" ON "dealer_payout_batches" ("dealer_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_commission_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"salesperson_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
	"milestone" text NOT NULL,
	"kind" text DEFAULT 'ACCRUAL' NOT NULL,
	"rule_id" uuid REFERENCES "dealer_commission_rules"("id") ON DELETE RESTRICT,
	"rule_version" integer,
	"fee_paise" integer DEFAULT 0 NOT NULL,
	"base_paise" integer DEFAULT 0 NOT NULL,
	"rating" numeric(3, 1),
	"bonus_bp" integer DEFAULT 0 NOT NULL,
	"bonus_paise" integer DEFAULT 0 NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" text DEFAULT 'EARNED' NOT NULL,
	"held_from_status" text,
	"above_cap" boolean DEFAULT false NOT NULL,
	"reverses_id" uuid REFERENCES "dealer_commission_ledger"("id") ON DELETE RESTRICT,
	"payout_batch_id" uuid REFERENCES "dealer_payout_batches"("id") ON DELETE SET NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_commission_ledger_milestone" CHECK ("milestone" in ('REGISTERED', 'VERIFIED_CATALOGUE', 'ACTIVATED')),
	CONSTRAINT "dealer_commission_ledger_kind" CHECK ("kind" in ('ACCRUAL', 'REVERSAL', 'ADJUSTMENT')),
	CONSTRAINT "dealer_commission_ledger_status" CHECK ("status" in ('EARNED', 'PENDING', 'APPROVED', 'PAID', 'REVERSED', 'ON_HOLD')),
	CONSTRAINT "dealer_commission_ledger_sign" CHECK (("kind" <> 'ACCRUAL' OR "amount_paise" >= 0) AND ("kind" <> 'REVERSAL' OR "amount_paise" <= 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_ledger_accrual_unique" ON "dealer_commission_ledger" ("shop_id", "milestone", "above_cap") WHERE "kind" = 'ACCRUAL';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_dealer_idx" ON "dealer_commission_ledger" ("dealer_id", "status", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_shop_idx" ON "dealer_commission_ledger" ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_batch_idx" ON "dealer_commission_ledger" ("payout_batch_id") WHERE "payout_batch_id" IS NOT NULL;
