-- RBAC v2, Phase 2 (owner brief 22-Nov-2026; docs/rbac/01-assessment.md). ADDITIVE ONLY, safe to re-run.
--  * five staff roles on user_role (values are not used in this file);
--  * feature_flags.role_scope (NULL = every role) and the rbac_v2_* flags, seeded OFF;
--  * one generic approval engine: approval_requests, approval_request_items, approval_decisions
--    (decisions append-only by trigger, like audit_logs).
-- No foreign keys between seller- and customer-side tables (service checks those links).
-- Rollback: scripts/rollback-0170.sql (enum values cannot be dropped; they stay unused).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'user_role' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''ACCOUNTANT''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''SUPPORT_MANAGER''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''SUPPORT_USER''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''OPERATIONS_MANAGER''';
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''OPERATIONS_USER''';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "feature_flags" ADD COLUMN IF NOT EXISTS "role_scope" text[];
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES
  ('rbac_v2_staff_roles', false),
  ('rbac_v2_four_eye_admin', false),
  ('rbac_v2_accounting', false),
  ('rbac_v2_support', false),
  ('rbac_v2_shop_change_requests', false),
  ('rbac_v2_operations', false)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','PARTIALLY_APPROVED','REJECTED','CANCELLED','EXPIRED','SUPERSEDED','FAILED')),
  "checker" text NOT NULL CHECK ("checker" IN ('ADMIN','CA','SHOP_OWNER','CA_THEN_ADMIN')),
  "stage" integer NOT NULL DEFAULT 1,
  "subject_type" text NOT NULL,
  "subject_id" text,
  "shop_id" uuid,
  "title" text NOT NULL,
  "reason" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requested_by" uuid NOT NULL,
  "requested_by_role" text NOT NULL,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "decision_comment" text,
  "single_admin" boolean NOT NULL DEFAULT false,
  "effective_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "confirm_by" timestamp with time zone,
  "applied_at" timestamp with time zone,
  "apply_error" text,
  "linked_ticket_id" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_status_idx" ON "approval_requests" ("status", "checker", "requested_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_subject_idx" ON "approval_requests" ("subject_type", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_shop_idx" ON "approval_requests" ("shop_id") WHERE "shop_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_request_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL REFERENCES "approval_requests"("id") ON DELETE CASCADE,
  "position" integer NOT NULL DEFAULT 0,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "field" text NOT NULL,
  "previous_value" jsonb,
  "proposed_value" jsonb,
  "final_value" jsonb,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','SUPERSEDED','EXPIRED','CANCELLED')),
  "decided_by" uuid,
  "decided_at" timestamp with time zone,
  "rejection_comment" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_request_items_request_idx" ON "approval_request_items" ("request_id", "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL REFERENCES "approval_requests"("id") ON DELETE CASCADE,
  "item_id" uuid,
  "action" text NOT NULL CHECK ("action" IN ('SUBMIT','APPROVE','REJECT','CANCEL','EXPIRE','SUPERSEDE','APPLY','APPLY_FAILED','REMIND','CONFIRM')),
  "actor_id" uuid,
  "actor_role" text,
  "comment" text,
  "single_admin" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_decisions_request_idx" ON "approval_decisions" ("request_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION approval_decisions_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval_decisions is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS approval_decisions_append_only ON "approval_decisions";
--> statement-breakpoint
CREATE TRIGGER approval_decisions_append_only
  BEFORE UPDATE OR DELETE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION approval_decisions_block_mutation();
