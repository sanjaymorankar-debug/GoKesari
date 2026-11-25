-- PAY-SM: payment settlement states RECONCILED and CHARGEBACK (docs/payment-settlement-states-2026-11.md).
--
-- * payment_intents.settlement_state: NULL (not yet confirmed), RECONCILED (the gateway's status check confirmed
--   the captured payment), CHARGEBACK (the customer's bank disputed it). Kept apart from "status" so refunds,
--   finance reports and every purpose's handlers, which read status, do not change.
-- * payment_chargebacks: one row per gateway dispute (amount in paise, reason, respond-by deadline, outcome).
-- * feature flag payment_settlement_states (OFF): with it off, the reconcile step and the dispute webhook
--   change nothing.
--
-- Additive and safe to re-run. Rollback: drop the table and the four columns, delete the flag row.
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "settlement_state" text;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "reconciled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "settlement_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN IF NOT EXISTS "settlement_checks" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_intents_settlement_state_check') THEN
    ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_settlement_state_check"
      CHECK ("settlement_state" IS NULL OR "settlement_state" IN ('RECONCILED', 'CHARGEBACK'));
  END IF;
END $$;
--> statement-breakpoint
-- The reconcile step's work list: paid intents not yet confirmed.
CREATE INDEX IF NOT EXISTS "payment_intents_settlement_due_idx" ON "payment_intents" ("captured_at")
  WHERE "settlement_state" IS NULL AND "status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_chargebacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "gateway" text NOT NULL,
  "gateway_dispute_id" text NOT NULL,
  "intent_id" uuid REFERENCES "payment_intents"("id") ON DELETE SET NULL,
  "gateway_order_id" text,
  "gateway_payment_id" text,
  "dispute_type" text,
  "gateway_status" text NOT NULL,
  "outcome" text DEFAULT 'OPEN' NOT NULL,
  "amount_paise" bigint NOT NULL,
  "reason_code" text,
  "reason" text,
  "respond_by" timestamp with time zone,
  "opened_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "last_event_at" timestamp with time zone NOT NULL,
  "last_webhook_event_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_chargebacks_outcome_check" CHECK ("outcome" IN ('OPEN', 'WON', 'LOST', 'CLOSED')),
  CONSTRAINT "payment_chargebacks_amount_check" CHECK ("amount_paise" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_chargebacks_gateway_dispute_uq" ON "payment_chargebacks" ("gateway", "gateway_dispute_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_chargebacks_intent_idx" ON "payment_chargebacks" ("intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_chargebacks_open_idx" ON "payment_chargebacks" ("outcome", "respond_by");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('payment_settlement_states', false) ON CONFLICT DO NOTHING;
