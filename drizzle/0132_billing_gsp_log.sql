-- split: core
-- Billing v2, phase 6 (docs/billing §9.7, §9.8, §9.10): the log of every GSP call, the e-invoice of a
-- credit note, and e-way bill Part B / extension / cancellation marks. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0132.sql
CREATE TABLE IF NOT EXISTS "gsp_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"request_id" text NOT NULL,
	"actor_id" uuid,
	"outcome" text NOT NULL,
	"error_code" text,
	"message" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gsp_call_log_outcome_check" CHECK ("outcome" IN ('OK', 'ERROR'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsp_call_log_shop_idx" ON "gsp_call_log" USING btree ("shop_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsp_call_log_created_idx" ON "gsp_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note_einvoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"irn" text,
	"ack_no" text,
	"ack_date" timestamp with time zone,
	"signed_qr" text,
	"error_message" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_note_einvoices_status_check" CHECK ("status" IN ('PENDING', 'GENERATED', 'FAILED', 'CANCELLED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_note_einvoices_note_uq" ON "credit_note_einvoices" USING btree ("credit_note_id");--> statement-breakpoint
ALTER TABLE "eway_bills" ADD COLUMN IF NOT EXISTS "part_b_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eway_bills" ADD COLUMN IF NOT EXISTS "extensions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "eway_bills" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eway_bills" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
