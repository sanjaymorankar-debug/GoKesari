-- split: core
-- Rider bank payouts (docs/gig-bank-payouts-2026-10): delivery partners withdraw their earnings to
-- their own verified bank account (the user's personal bank_accounts row, the same one customers use
-- for refunds), and a monthly run on the 5th (09:00 IST) pays every eligible rider what is still
-- unpaid for the previous month. Each payment is a rider_payouts row (the existing weekly lifecycle)
-- plus one rider_bank_transfers row that carries the bank transfer: provider, status, retries, TDS.
-- rider_payout_runs: one row per paid month — inserting it is the guard that makes the run once.
-- rider_security_grants: a short-lived "re-authenticated" mark (emailed code) for changing or
-- removing a rider's bank account.
-- Owner decisions 31 Oct 2026: riders only (the customer wallet stays closed), weekly payouts stay,
-- limits ₹100–₹10,000 no fee, TDS s.194C. Every table is platform (core database); no link to a
-- seller table.
-- ADDITIVE ONLY; idempotent. Three feature flags seeded OFF. Rollback: scripts/rollback-0124.sql
CREATE TABLE IF NOT EXISTS "rider_payout_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"runs" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"started_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"eligible" integer DEFAULT 0 NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"gross_paise" bigint DEFAULT 0 NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"net_paise" bigint DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "rider_payout_runs_period" CHECK ("period_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "rider_payout_runs_status" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_FAILURES'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_payout_runs_period_unique" ON "rider_payout_runs" ("period_month");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_bank_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE RESTRICT,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
	"payout_id" uuid NOT NULL REFERENCES "rider_payouts"("id") ON DELETE RESTRICT,
	"kind" text NOT NULL,
	"run_id" uuid REFERENCES "rider_payout_runs"("id") ON DELETE RESTRICT,
	"bank_account_id" uuid NOT NULL REFERENCES "bank_accounts"("id") ON DELETE RESTRICT,
	"method" text NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"gross_paise" bigint NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"tds_rate_bp" integer DEFAULT 0 NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"net_paise" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"needs_review" boolean DEFAULT false NOT NULL,
	"provider_ref" text,
	"utr" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "rider_bank_transfers_kind" CHECK ("kind" IN ('WITHDRAWAL', 'MONTHLY')),
	CONSTRAINT "rider_bank_transfers_status" CHECK ("status" IN ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED', 'RELEASED')),
	CONSTRAINT "rider_bank_transfers_amounts" CHECK ("gross_paise" > 0 AND "tds_paise" >= 0 AND "fee_paise" >= 0 AND "net_paise" = "gross_paise" - "tds_paise" - "fee_paise" AND "net_paise" > 0),
	CONSTRAINT "rider_bank_transfers_run" CHECK (("kind" = 'MONTHLY') = ("run_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_bank_transfers_payout_unique" ON "rider_bank_transfers" ("payout_id");--> statement-breakpoint
-- One monthly payment per rider per run, however often the run is re-started.
CREATE UNIQUE INDEX IF NOT EXISTS "rider_bank_transfers_run_partner_unique" ON "rider_bank_transfers" ("run_id", "delivery_partner_id") WHERE "run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_bank_transfers_partner_idx" ON "rider_bank_transfers" ("delivery_partner_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_bank_transfers_status_idx" ON "rider_bank_transfers" ("status", "next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_bank_transfers_provider_ref_idx" ON "rider_bank_transfers" ("provider_ref") WHERE "provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_transfer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL REFERENCES "rider_bank_transfers"("id") ON DELETE CASCADE,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_transfer_events_source_event_unique" ON "rider_transfer_events" ("source", "event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_transfer_events_transfer_idx" ON "rider_transfer_events" ("transfer_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_security_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_security_grants_purpose" CHECK ("purpose" IN ('BANK_ACCOUNT_CHANGE'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_security_grants_user_idx" ON "rider_security_grants" ("user_id", "purpose", "expires_at");--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES
	('rider_bank_account_enabled', false),
	('rider_withdrawal_enabled', false),
	('rider_monthly_payout_enabled', false)
ON CONFLICT DO NOTHING;
