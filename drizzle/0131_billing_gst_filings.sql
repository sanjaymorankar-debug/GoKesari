-- split: seller
-- Billing v2, phase 6 (docs/billing §9): the shop's GST returns per period (prepared, saved to the
-- portal through the GSP, filed with EVC) and its IMS decision on each inward invoice.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0131.sql
CREATE TABLE IF NOT EXISTS "gst_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"return_type" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'PREPARED' NOT NULL,
	"payload" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"our_summary" jsonb,
	"portal_summary" jsonb,
	"reference_id" text,
	"arn" text,
	"error" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone,
	"filed_at" timestamp with time zone,
	"filed_by" uuid,
	CONSTRAINT "gst_filings_type_check" CHECK ("return_type" IN ('GSTR1', 'IFF', 'GSTR3B', 'CMP08', 'GSTR4')),
	CONSTRAINT "gst_filings_status_check" CHECK ("status" IN ('PREPARED', 'SAVED', 'FILED', 'ERROR'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gst_filings_period_uq" ON "gst_filings" USING btree ("shop_id", "return_type", "period");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ims_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"period" text NOT NULL,
	"supplier_gstin" text NOT NULL,
	"doc_type" text NOT NULL,
	"doc_number" text NOT NULL,
	"doc_date" date,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"pushed" text DEFAULT 'NOT_SENT' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ims_actions_action_check" CHECK ("action" IN ('ACCEPTED', 'REJECTED', 'PENDING')),
	CONSTRAINT "ims_actions_pushed_check" CHECK ("pushed" IN ('NOT_SENT', 'SENT', 'FAILED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ims_actions_doc_uq" ON "ims_actions" USING btree ("shop_id", "supplier_gstin", "doc_type", "doc_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ims_actions_period_idx" ON "ims_actions" USING btree ("shop_id", "period");
