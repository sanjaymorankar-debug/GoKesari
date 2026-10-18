-- Rollback for 0079_batch_a_payments (WS-A payment gateway, payment intents, OTP indexes (F1.7.3, F1.8.4, F1.1.2)).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0079 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Online payment attempts, their gateway webhooks and refunds are lost. Do NOT roll back while
-- any order is paid ONLINE and not yet delivered or refunded — settle those first:
--   SELECT id, order_number, status FROM orders WHERE payment_method = 'ONLINE' AND status NOT IN ('DELIVERED', 'REFUNDED', 'CANCELLED', 'PAYMENT_FAILED');
-- Not reversible: PostgreSQL cannot drop an enum value. Left in place (harmless to
-- the previous code, which never writes it): payment_method.ONLINE.
BEGIN;
DROP INDEX IF EXISTS "login_otps_ip_created_idx";
DROP INDEX IF EXISTS "login_otps_expires_idx";
DROP TABLE IF EXISTS "payment_sandbox_orders" CASCADE;
DROP TABLE IF EXISTS "payment_refunds" CASCADE;
DROP TABLE IF EXISTS "payment_webhook_events" CASCADE;
DROP TABLE IF EXISTS "payment_intent_events" CASCADE;
DROP TABLE IF EXISTS "payment_intents" CASCADE;
COMMIT;
