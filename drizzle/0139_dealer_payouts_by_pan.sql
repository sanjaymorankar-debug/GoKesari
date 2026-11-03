-- split: seller
-- Gap report of 02-Nov-2026 (docs/referrals-dealer-2026-11/GAP_REPORT.md, Part C): one dealer
-- commission payout per PAN per month (a person in two roles is paid once), and automatic bank
-- transfer through the shop payout providers (rule dealerAutoPayout, off): an admin other than the
-- one who drafted it approves the payout (maker-checker), it is sent, the provider's signed
-- webhook brings the UTR, a failure is retried with backoff and then flagged for finance. Paying by
-- hand (the bank reference) stays available. Safe to rerun. Rollback: scripts/rollback-0139.sql.
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "payee_pan_hash" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "provider_ref" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "failure_reason" text;--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" DROP CONSTRAINT IF EXISTS "dealer_payout_batches_status";--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD CONSTRAINT "dealer_payout_batches_status" CHECK ("status" in ('DRAFT', 'APPROVED', 'PROCESSING', 'FAILED', 'PAID', 'CANCELLED'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_pan_idx" ON "dealer_payout_batches" ("payee_pan_hash", "period_month") WHERE "payee_pan_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_retry_idx" ON "dealer_payout_batches" ("status", "next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_payout_batches_provider_ref_idx" ON "dealer_payout_batches" ("provider_ref") WHERE "provider_ref" IS NOT NULL;--> statement-breakpoint
-- Existing payouts: the PAN of the dealer or member they were for.
UPDATE "dealer_payout_batches" b SET "payee_pan_hash" = COALESCE(
  (SELECT s."pan_hash" FROM "dealer_salespeople" s WHERE s."id" = b."member_id"),
  CASE WHEN b."member_id" IS NULL THEN (SELECT d."pan_hash" FROM "dealers" d WHERE d."id" = b."dealer_id") END)
 WHERE b."payee_pan_hash" IS NULL;
