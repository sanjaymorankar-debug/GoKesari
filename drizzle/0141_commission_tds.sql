-- split: core
-- Gap report of 02-Nov-2026, Part D (TDS on commission): dated TDS rows by payee type and PAN
-- status (rate, annual threshold, CATCH_UP / EXCESS_ONLY, free-text section, effective dates, CA
-- confirmation), lower / nil certificates per payee, challans and Form 16A per quarter. Platform
-- tables (core database). Seeded with the brief's STARTING values, NOT confirmed by the CA:
-- 2% (PAN) / 20% (no PAN) above Rs 20,000 a year — while rule dealerPayoutTds is on, an
-- unconfirmed row blocks the payout unless an admin overrides it with a reason. Safe to rerun.
-- Rollback: scripts/rollback-0141.sql.
CREATE TABLE IF NOT EXISTS "commission_tds_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payee_type" text NOT NULL,
	"pan_status" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"threshold_paise" bigint NOT NULL,
	"mode" text DEFAULT 'CATCH_UP' NOT NULL,
	"section" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"note" text,
	"confirmed_by_ca" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_tds_rates_rate" CHECK ("rate_bp" BETWEEN 0 AND 10000 AND "threshold_paise" >= 0),
	CONSTRAINT "commission_tds_rates_dates" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
	CONSTRAINT "commission_tds_rates_kind" CHECK ("payee_type" in ('INDIVIDUAL', 'FIRM', 'COMPANY', 'ANY') AND "pan_status" in ('PAN_OK', 'NO_PAN') AND "mode" in ('CATCH_UP', 'EXCESS_ONLY'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_tds_rates_from_unique" ON "commission_tds_rates" ("payee_type", "pan_status", "effective_from");--> statement-breakpoint
INSERT INTO "commission_tds_rates" ("payee_type", "pan_status", "rate_bp", "threshold_paise", "mode", "section", "effective_from", "note")
VALUES
	('ANY', 'PAN_OK', 200, 2000000, 'CATCH_UP', 'Commission or brokerage (old s.194H) — new section under the Income-tax Act 2025 to be given by the CA', DATE '2026-04-01', 'Starting value from the owner brief of 02-Nov-2026; not confirmed by the CA'),
	('ANY', 'NO_PAN', 2000, 0, 'CATCH_UP', 'Commission or brokerage without PAN (old s.206AA) — to be given by the CA', DATE '2026-04-01', 'Starting value from the owner brief of 02-Nov-2026; not confirmed by the CA')
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_tds_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pan_hash" text NOT NULL,
	"payee_label" text NOT NULL,
	"certificate_number" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"limit_paise" bigint,
	"note" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_tds_certificates_rate" CHECK ("rate_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "commission_tds_certificates_dates" CHECK ("valid_to" >= "valid_from"),
	CONSTRAINT "commission_tds_certificates_status" CHECK ("status" in ('ACTIVE', 'WITHDRAWN'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_tds_certificates_pan_idx" ON "commission_tds_certificates" ("pan_hash", "valid_from");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_tds_challans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" text NOT NULL,
	"section" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"bsr_code" text NOT NULL,
	"challan_serial" text NOT NULL,
	"deposited_on" date NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_tds_challans_unique" ON "commission_tds_challans" ("bsr_code", "challan_serial", "deposited_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_tds_challans_month_idx" ON "commission_tds_challans" ("period_month");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commission_tds_forms16a" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pan_hash" text NOT NULL,
	"payee_label" text NOT NULL,
	"financial_year" text NOT NULL,
	"quarter" smallint NOT NULL,
	"certificate_number" text NOT NULL,
	"file_name" text NOT NULL,
	"data_encrypted" bytea NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_tds_forms16a_quarter" CHECK ("quarter" BETWEEN 1 AND 4)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commission_tds_forms16a_unique" ON "commission_tds_forms16a" ("pan_hash", "financial_year", "quarter");
