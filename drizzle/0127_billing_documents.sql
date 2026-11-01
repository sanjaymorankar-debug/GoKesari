-- split: core
-- Billing v2, phase 2 (docs/billing §4, §5.2): the customer's GSTIN on an order (B2B checkout),
-- cancellation marks on tax invoices, issued invoices and credit notes made unchangeable, and
-- GoKesari's own delivery-fee invoice to the customer under s.9(5). ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0127.sql
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "buyer_gstin" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "buyer_legal_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "buyer_gstin_status" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_gstin_status_check" CHECK ("buyer_gstin_status" IS NULL OR "buyer_gstin_status" IN ('VERIFIED', 'UNVERIFIED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'ISSUED' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "cancel_reason" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_status_check" CHECK ("status" IN ('ISSUED', 'CANCELLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_delivery_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE restrict,
	"customer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"financial_year" text NOT NULL,
	"sequence" integer NOT NULL,
	"supply_type" text NOT NULL,
	"place_of_supply" text,
	"rate_bp" integer NOT NULL,
	"fee_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_delivery_invoices_status_check" CHECK ("status" IN ('ISSUED', 'CANCELLED')),
	CONSTRAINT "platform_delivery_invoices_supply_check" CHECK ("supply_type" IN ('INTRA', 'INTER'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_delivery_invoices_order_uq" ON "platform_delivery_invoices" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_delivery_invoices_number_uq" ON "platform_delivery_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_delivery_invoices_seq_uq" ON "platform_delivery_invoices" USING btree ("financial_year", "sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_delivery_invoices_customer_idx" ON "platform_delivery_invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "platform_delivery_invoices_issued_idx" ON "platform_delivery_invoices" USING btree ("issued_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_delivery_invoice_counters" (
	"financial_year" text PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL
);--> statement-breakpoint
-- An issued GST document keeps its number, values and contents for good (Rule 46, §4.2): only the
-- cancellation fields may change, once, from ISSUED to CANCELLED. Deleting is refused.
CREATE OR REPLACE FUNCTION gst_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An issued GST document cannot be deleted (%).', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason'])
     OR (OLD.status = 'CANCELLED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'An issued GST document cannot be changed (%); cancel it or issue a credit / debit note.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tax_invoices_immutable" ON "tax_invoices";--> statement-breakpoint
CREATE TRIGGER "tax_invoices_immutable" BEFORE UPDATE OR DELETE ON "tax_invoices" FOR EACH ROW EXECUTE FUNCTION gst_document_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS "platform_delivery_invoices_immutable" ON "platform_delivery_invoices";--> statement-breakpoint
CREATE TRIGGER "platform_delivery_invoices_immutable" BEFORE UPDATE OR DELETE ON "platform_delivery_invoices" FOR EACH ROW EXECUTE FUNCTION gst_document_immutable();
