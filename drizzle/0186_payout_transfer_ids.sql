-- Payouts: the provider transfer id of each attempt, and webhooks waiting for their payout (23-Nov-2026).
--
-- * provider_transfer_id on payout_items, rider_bank_transfers and dealer_payout_batches: the id the payout
--   provider knows the current attempt by (for Cashfree, its transfer_id). Saved when the attempt is claimed,
--   before the request is sent, so a webhook or a status lookup matches the row even when the provider's own
--   reference (provider_ref) is not known yet.
-- * dealer_payout_batches.sent_at: when the current attempt was sent (the reconcile job's clock).
-- * payout_webhook_parked: a correctly signed webhook that matched no payout yet. It is answered 409 so the
--   provider delivers it again, and is marked matched once it is applied.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0186.sql.
ALTER TABLE "payout_items" ADD COLUMN IF NOT EXISTS "provider_transfer_id" text;
--> statement-breakpoint
ALTER TABLE "rider_bank_transfers" ADD COLUMN IF NOT EXISTS "provider_transfer_id" text;
--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "provider_transfer_id" text;
--> statement-breakpoint
ALTER TABLE "dealer_payout_batches" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_items_provider_transfer_id_unique" ON "payout_items" ("provider_transfer_id") WHERE "provider_transfer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_bank_transfers_provider_transfer_id_unique" ON "rider_bank_transfers" ("provider_transfer_id") WHERE "provider_transfer_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_payout_batches_provider_transfer_id_unique" ON "dealer_payout_batches" ("provider_transfer_id") WHERE "provider_transfer_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_webhook_parked" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source" text NOT NULL,
  "event_id" text NOT NULL,
  "provider_ref" text,
  "transfer_id" text,
  "status" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "deliveries" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "matched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_webhook_parked_source_event_unique" ON "payout_webhook_parked" ("source", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_webhook_parked_open_idx" ON "payout_webhook_parked" ("first_seen_at") WHERE "matched_at" IS NULL;
