-- split: seller
-- Dealer programme step 4 (docs/dealer-programme, GKS-SH-004): every decision of the instant
-- approval on government GST/PAN verification + online payment, with its evidence (verification
-- status, provider reference, name-match score, the gateway-confirmed payment), or why the shop
-- waits for an admin. Append-only. No personal numbers are stored (PAN only masked).
-- ADDITIVE ONLY; idempotent.
CREATE TABLE IF NOT EXISTS "shop_auto_approval_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"rule" text DEFAULT 'GOV_VERIFICATION' NOT NULL,
	"outcome" text NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_auto_approval_log_outcome" CHECK ("outcome" in ('APPROVED', 'PENDING')),
	CONSTRAINT "shop_auto_approval_log_rule" CHECK ("rule" in ('GOV_VERIFICATION'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_auto_approval_log_shop_idx" ON "shop_auto_approval_log" ("shop_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_auto_approval_log_outcome_idx" ON "shop_auto_approval_log" ("outcome", "created_at");
