-- RBAC v2 Phase 6 — Operations (docs/rbac/06-operations.md). Additive only:
--   * ops_zone_assignments   which Operations User works which franchise zone (zone_id text, no FK)
--   * ops_tasks              onboarding / follow-up tasks an Operations Manager assigns
--   * ops_task_events        every change to a task, append-only (trigger blocks UPDATE/DELETE)
--   * ops_customer_assists   a customer an Operations User is helping to register
-- Users, shops and zones are referenced without foreign keys (the service checks the links).
-- Everything here is used only while feature flag rbac_v2_operations (0170, seeded OFF) is on.
-- Safe to re-run. Rollback: scripts/rollback-0174.sql.
CREATE TABLE IF NOT EXISTS "ops_zone_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "zone_id" text NOT NULL,
  "assigned_by" uuid NOT NULL,
  "reason" text,
  "active" boolean NOT NULL DEFAULT true,
  "assigned_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone,
  "ended_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ops_zone_assignments_active_uq" ON "ops_zone_assignments" ("user_id", "zone_id") WHERE "active";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_zone_assignments_zone_idx" ON "ops_zone_assignments" ("zone_id") WHERE "active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL CHECK ("kind" IN ('SHOP_ONBOARDING','CUSTOMER_ONBOARDING','FOLLOW_UP','DOCUMENT_COLLECTION','OTHER')),
  "title" text NOT NULL,
  "notes" text,
  "status" text NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  "priority" text NOT NULL DEFAULT 'NORMAL' CHECK ("priority" IN ('LOW','NORMAL','HIGH','URGENT')),
  "assignee_user_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "shop_id" uuid,
  "customer_user_id" uuid,
  "assist_id" uuid,
  "zone_id" text,
  "due_at" timestamp with time zone,
  "follow_up_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "outcome" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_tasks_assignee_idx" ON "ops_tasks" ("assignee_user_id", "status", "due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_tasks_shop_idx" ON "ops_tasks" ("shop_id") WHERE "shop_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_tasks_created_idx" ON "ops_tasks" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops_task_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "ops_tasks"("id") ON DELETE RESTRICT,
  "action" text NOT NULL CHECK ("action" IN ('CREATE','ASSIGN','REASSIGN','START','FOLLOW_UP','NOTE','DONE','CANCEL','REOPEN')),
  "actor_id" uuid NOT NULL,
  "actor_role" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "assignee_user_id" uuid,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_task_events_task_idx" ON "ops_task_events" ("task_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_task_events_actor_idx" ON "ops_task_events" ("actor_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ops_task_events_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops_task_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ops_task_events_append_only ON "ops_task_events";
--> statement-breakpoint
CREATE TRIGGER ops_task_events_append_only
  BEFORE UPDATE OR DELETE ON "ops_task_events"
  FOR EACH ROW EXECUTE FUNCTION ops_task_events_block_mutation();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops_customer_assists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ops_user_id" uuid NOT NULL,
  "customer_name" text NOT NULL,
  "contact_email" text,
  "contact_phone" text,
  "pincode" text,
  "zone_id" text,
  "status" text NOT NULL DEFAULT 'ENQUIRY' CHECK ("status" IN ('ENQUIRY','INVITED','REGISTERED','PROFILE_COMPLETE','DROPPED')),
  "customer_user_id" uuid,
  "notes" text,
  "follow_up_at" timestamp with time zone,
  "registered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ops_customer_assists_contact" CHECK ("contact_email" IS NOT NULL OR "contact_phone" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_customer_assists_user_idx" ON "ops_customer_assists" ("ops_user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_customer_assists_email_idx" ON "ops_customer_assists" (lower("contact_email")) WHERE "customer_user_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ops_customer_assists_customer_uq" ON "ops_customer_assists" ("customer_user_id") WHERE "customer_user_id" IS NOT NULL;
