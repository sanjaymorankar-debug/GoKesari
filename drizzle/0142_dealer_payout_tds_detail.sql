-- split: seller
-- Gap report D3 (02-Nov-2026): each dealer payout keeps the dated TDS row, section and certificate
-- it was taxed under, a flag for the CA (UNCONFIRMED_RATE / NO_RATE block paying until an admin
-- overrides with a reason; REVERSAL_PRIOR_FY is a reversal crossing a financial year), and the
-- override. Safe to rerun. Rollback: scripts/rollback-0142.sql.
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_section" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_flag" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_override_reason" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "tds_override_by" uuid;
