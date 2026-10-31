-- split: core
-- HDFC Bank SmartGateway as a fifth online-payment gateway (PAYMENT_GATEWAY=HDFC,
-- src/server/payments/gateway/hdfc.ts). payment_intents.gateway may now be 'HDFC'.
-- Core (customer) database only. The constraint is replaced with a superset; idempotent.
-- Rollback: scripts/rollback-0119.sql
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_gateway_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_gateway_check" CHECK ("gateway" IN ('SANDBOX', 'CASHFREE', 'RAZORPAY', 'PHONEPE', 'HDFC'));
