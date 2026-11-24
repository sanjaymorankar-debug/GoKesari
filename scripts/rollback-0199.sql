-- Rollback for 0199_account_deletion_cooling_off (Module 7 cooling-off; docs/account-deletion-2026-11/).
-- Before running: deploy the previous release's code, then delete the 0199 row from drizzle.__drizzle_migrations.
-- Accounts still in their cooling-off period are switched back on (ACTIVE) and their requests CANCELLED, because
-- the previous code knows neither the status nor the request state. Accounts already purged stay anonymised.
-- The enum value PENDING_DELETION stays in user_status (PostgreSQL cannot drop an enum value); nothing uses it.
UPDATE "users" SET "status" = 'ACTIVE', "updated_at" = now() WHERE "status" = 'PENDING_DELETION';
UPDATE "account_deletion_requests" SET "status" = 'CANCELLED' WHERE "status" = 'COOLING_OFF';
ALTER TABLE "account_deletion_requests" DROP CONSTRAINT IF EXISTS "account_deletion_requests_status_check";
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_status_check" CHECK ("status" IN ('REQUESTED', 'BLOCKED', 'COMPLETED', 'CANCELLED'));
DROP INDEX IF EXISTS "account_deletion_requests_purge_idx";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "cancel_note";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "cancelled_by";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "cancelled_at";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "hidden_state";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "purge_after";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "cooling_started_at";
ALTER TABLE "account_deletion_requests" DROP COLUMN IF EXISTS "reason_code";
