-- Rollback for 0119_hdfc_gateway (HDFC SmartGateway, 30 Oct 2026).
-- Core database. Run only after the previous release's code is live, then delete the 0119 row
-- from drizzle.__drizzle_migrations. Fails while any HDFC attempt exists (the old constraint
-- would not validate): close or move those first.
BEGIN;
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_gateway_check";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_gateway_check" CHECK ("gateway" IN ('SANDBOX', 'CASHFREE', 'RAZORPAY', 'PHONEPE'));
COMMIT;
