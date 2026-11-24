-- Module 7: self-service account deletion (owner brief 23-Nov-2026; docs/account-deletion-2026-11/README.md).
--
-- * account_deletion_requests: one row per deletion request — REQUESTED when the confirmation code is sent,
--   BLOCKED when a check refused it (blockers lists why), COMPLETED once the account was anonymised.
--   No foreign key to users: the row is the record that the request was honoured, kept after the
--   account's personal data is gone.
-- * feature flag account_self_deletion_enabled (OFF): when OFF the My Profile section is hidden and the
--   /api/profile/delete APIs answer 404, so the app behaves exactly as before.
-- * login_otps.purpose gains the value ACCOUNT_DELETE (plain text column, no constraint to change).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0188.sql.
CREATE TABLE IF NOT EXISTS "account_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text DEFAULT 'REQUESTED' NOT NULL,
  "blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "ip_address" text,
  "user_agent" text,
  CONSTRAINT "account_deletion_requests_status_check" CHECK ("status" IN ('REQUESTED', 'BLOCKED', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_requests_user_idx" ON "account_deletion_requests" ("user_id", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_deletion_requests_status_idx" ON "account_deletion_requests" ("status", "requested_at");
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('account_self_deletion_enabled', false) ON CONFLICT DO NOTHING;
