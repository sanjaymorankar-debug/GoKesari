-- split: seller
-- Billing v2, release #332 code check B-1 (03-Nov-2026): a counter / POS bill keeps the document it
-- was issued as (tax invoice or bill of supply), so a later change in the shop's GST status no longer
-- retitles bills already issued. Existing bills take what they print today (counterBillKind of the
-- shop now). Left nullable so the previous release, which does not set it, keeps issuing bills while
-- this migration is applied ahead of the deploy; a NULL bill reads as before.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0143.sql
ALTER TABLE "acc_sales_invoices" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
UPDATE "acc_sales_invoices" i
SET "kind" = CASE
  WHEN coalesce(s."gstin", '') <> ''
   AND CASE WHEN s."gst_registration_type" <> 'UNREGISTERED' THEN s."gst_registration_type" = 'REGULAR'
            ELSE s."gst_status"::text <> 'COMPOSITION' END
  THEN 'TAX_INVOICE' ELSE 'BILL_OF_SUPPLY' END
FROM "shops" s
WHERE s."id" = i."shop_id" AND i."kind" IS NULL;--> statement-breakpoint
ALTER TABLE "acc_sales_invoices" DROP CONSTRAINT IF EXISTS "acc_sales_invoices_kind";--> statement-breakpoint
ALTER TABLE "acc_sales_invoices" ADD CONSTRAINT "acc_sales_invoices_kind" CHECK ("kind" IS NULL OR "kind" IN ('TAX_INVOICE', 'BILL_OF_SUPPLY'));
