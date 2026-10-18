-- 0079 batch-2026-10 WS-A: direct online payment (F1.7.3 / F1.8.4, docs/payments-gateway-2026-10.md).
--   payment_method          + 'ONLINE' (orders paid at a payment gateway; rule onlinePayments, default off)
--   payment_intents         one gateway payment for one purpose, with its state machine
--   payment_intent_events   status history of an intent
--   payment_webhook_events  every webhook delivery; (gateway, event_id) UNIQUE = processing idempotency
--   payment_refunds         refunds to the original method; merchant_refund_id UNIQUE at the gateway
--   payment_sandbox_orders  the sandbox gateway's own ledger (tests / staging only)
--   login_otps              + index for the per-IP OTP limit and the expired-code purge
-- All customer-owned (docs/db-split-2026-10). Additive only: new tables, a new
-- enum value (not used in this file), new indexes.
ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'ONLINE';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"user_id" uuid,
	"amount_paise" bigint NOT NULL,
	"refunded_paise" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"gateway" text NOT NULL,
	"mode" text DEFAULT 'CHECKOUT' NOT NULL,
	"merchant_order_id" text NOT NULL,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"idempotency_key" text NOT NULL,
	"checkout_kind" text,
	"checkout_url" text,
	"checkout_token" text,
	"link_url" text,
	"method" text,
	"description" text NOT NULL,
	"return_path" text,
	"failure_reason" text,
	"expires_at" timestamp with time zone,
	"captured_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "payment_intents_amount_positive" CHECK ("amount_paise" > 0),
	CONSTRAINT "payment_intents_refund_within_amount" CHECK ("refunded_paise" >= 0 AND "refunded_paise" <= "amount_paise"),
	CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE')),
	CONSTRAINT "payment_intents_status_check" CHECK ("status" IN ('CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'EXPIRED')),
	CONSTRAINT "payment_intents_gateway_check" CHECK ("gateway" IN ('SANDBOX', 'CASHFREE', 'RAZORPAY', 'PHONEPE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_idempotency_key_uq" ON "payment_intents" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_merchant_order_uq" ON "payment_intents" ("merchant_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_reference_idx" ON "payment_intents" ("purpose", "reference_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_status_idx" ON "payment_intents" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_gateway_order_idx" ON "payment_intents" ("gateway", "gateway_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intents_user_idx" ON "payment_intents" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_intent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"webhook_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intent_events_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_intent_events_intent_idx" ON "payment_intent_events" ("intent_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text,
	"signature_ok" boolean NOT NULL,
	"intent_id" uuid,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	"raw_payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_webhook_events_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_events_gateway_event_uq" ON "payment_webhook_events" ("gateway", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_events_intent_idx" ON "payment_webhook_events" ("intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_webhook_events_received_idx" ON "payment_webhook_events" ("received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"merchant_refund_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"gateway_refund_id" text,
	"reason" text NOT NULL,
	"order_id" uuid,
	"submitted_at" timestamp with time zone,
	"failure_reason" text,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "payment_intents"("id") ON DELETE cascade,
	CONSTRAINT "payment_refunds_amount_positive" CHECK ("amount_paise" > 0),
	CONSTRAINT "payment_refunds_status_check" CHECK ("status" IN ('PENDING', 'SUCCESS', 'FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_refunds_merchant_refund_uq" ON "payment_refunds" ("merchant_refund_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_refunds_idempotency_key_uq" ON "payment_refunds" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_intent_idx" ON "payment_refunds" ("intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_refunds_status_idx" ON "payment_refunds" ("status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_sandbox_orders" (
	"gateway_order_id" text PRIMARY KEY NOT NULL,
	"merchant_order_id" text NOT NULL,
	"kind" text DEFAULT 'ORDER' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"payment_id" text,
	"method" text,
	"failure_reason" text,
	"refunds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_sandbox_orders_merchant_order_id_unique" UNIQUE("merchant_order_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otps_ip_created_idx" ON "login_otps" ("ip_address", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_otps_expires_idx" ON "login_otps" ("expires_at");
