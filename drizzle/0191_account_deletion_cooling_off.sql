-- Module 7 follow-up: a 90-day cooling-off period before a self-service account deletion
-- (owner 23-Nov-2026: "3 months of cooling-off period where the account will be hidden to all but will be
-- visible to admin with a comment 'under cooling period' for the specific reason";
-- docs/account-deletion-2026-11/README.md).
--
-- * user_status gains PENDING_DELETION: the account is hidden and cannot sign in (except to restore itself).
--   A separate value, not SUSPENDED, so an admin "reinstate" can never undo a person's own deletion request.
-- * account_deletion_requests gains COOLING_OFF and the columns the cooling-off needs: the picked reason code,
--   purge_after (when the daily job anonymises the account), cooling_started_at, hidden_state (what was switched
--   off, to switch it back on a restore) and who cancelled it with a note.
-- * index (status, purge_after) for the daily purge job.
--
-- Additive and safe to re-run (IF NOT EXISTS everywhere; the status CHECK is dropped and re-added wider).
-- No feature flag row: the whole module stays behind account_self_deletion_enabled (seeded OFF in 0183).
-- Rollback: scripts/rollback-0191.sql (the enum value stays; PostgreSQL cannot drop one).
ALTER TYPE "user_status" ADD VALUE IF NOT EXISTS 'PENDING_DELETION';
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "reason_code" text;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "cooling_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "purge_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "hidden_state" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "cancelled_by" uuid;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD COLUMN IF NOT EXISTS "cancel_note" text;
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" DROP CONSTRAINT IF EXISTS "account_deletion_requests_status_check";
--> statement-breakpoint
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_status_check" CHECK ("status" IN ('REQUESTED', 'BLOCKED', 'COOLING_OFF', 'COMPLETED', 'CANCELLED'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_requests_purge_idx" ON "account_deletion_requests" ("status", "purge_after");
