-- split: seller
-- Billing v2, phase 2 (docs/billing §4.1, §4.6): the shop's other GST documents (credit / debit
-- note on a counter sale, receipt and refund vouchers, delivery challan, estimate), each in its own
-- series, unchangeable once issued; and the shop's UPI id for the payment QR on counter bills.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0128.sql
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "upi_vpa" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acc_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"doc_no" text NOT NULL,
	"fy" text NOT NULL,
	"sequence" integer NOT NULL,
	"doc_date" date NOT NULL,
	"party_id" uuid REFERENCES "acc_parties"("id") ON DELETE restrict,
	"buyer_name" text,
	"buyer_gstin" text,
	"place_of_supply" text NOT NULL,
	"seller_state_code" text NOT NULL,
	"inter_state" boolean NOT NULL,
	"against_sales_id" uuid REFERENCES "acc_sales_invoices"("id") ON DELETE restrict,
	"against_document_id" uuid,
	"reason" text,
	"restock" boolean DEFAULT false NOT NULL,
	"payment_mode" text,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"lines" jsonb NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acc_documents_kind_check" CHECK ("kind" IN ('CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT_VOUCHER', 'REFUND_VOUCHER', 'DELIVERY_CHALLAN', 'ESTIMATE')),
	CONSTRAINT "acc_documents_status_check" CHECK ("status" IN ('ISSUED', 'CANCELLED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acc_documents_no_unique" ON "acc_documents" USING btree ("shop_id", "kind", "doc_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acc_documents_seq_unique" ON "acc_documents" USING btree ("shop_id", "kind", "fy", "sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acc_documents_shop_date_idx" ON "acc_documents" USING btree ("shop_id", "doc_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "acc_documents_against_sales_idx" ON "acc_documents" USING btree ("against_sales_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION acc_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The shop's own cascade (a shop removed in full) is the only delete allowed.
    IF NOT EXISTS (SELECT 1 FROM "shops" WHERE "id" = OLD."shop_id") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'An issued document cannot be deleted; cancel it.' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancel_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancel_reason'])
     OR (OLD.status = 'CANCELLED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'An issued document cannot be changed; cancel it and issue a new one.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "acc_documents_immutable" ON "acc_documents";--> statement-breakpoint
CREATE TRIGGER "acc_documents_immutable" BEFORE UPDATE OR DELETE ON "acc_documents" FOR EACH ROW EXECUTE FUNCTION acc_document_immutable();
