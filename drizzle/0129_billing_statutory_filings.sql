-- split: core
-- Billing v2, phase 3 (docs/billing §5.4, §5.5, §5.7): GoKesari's own statutory returns per period
-- (GSTR-8, GSTR-1, GSTR-3B, TDS statement) — what was generated, and the filing acknowledgement.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0129.sql
CREATE TABLE IF NOT EXISTS "statutory_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_type" text NOT NULL,
	"period" text NOT NULL,
	"registration" text NOT NULL,
	"status" text DEFAULT 'GENERATED' NOT NULL,
	"due_date" date NOT NULL,
	"payload" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" uuid,
	"filed_at" timestamp with time zone,
	"filed_by" uuid,
	"acknowledgement" text,
	"note" text,
	CONSTRAINT "statutory_filings_type_check" CHECK ("return_type" IN ('GSTR8', 'GSTR1', 'GSTR3B', 'TDS_STATEMENT')),
	CONSTRAINT "statutory_filings_status_check" CHECK ("status" IN ('GENERATED', 'SUBMITTED', 'FILED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "statutory_filings_period_uq" ON "statutory_filings" USING btree ("return_type", "period", "registration");
