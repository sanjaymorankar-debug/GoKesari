-- RBAC v2, Phases 4, 5 and 7 (docs/rbac/04-support-and-change-requests.md). ADDITIVE ONLY, safe to re-run.
--  * staff_team_members         Support / Operations teams: which manager a staff member reports to
--  * support_tickets + manager_user_id, sub_status (Pending Information / On Hold / Rejected), change_request_id,
--    ops_task_id, raised_by_staff — all nullable; the status CHECK is NOT altered (brief lifecycle mapped onto it)
--  * shop_mrp_history           append-only history of a shop's own MRP (shop_listing_details.mrp_paise)
-- Users are not referenced by foreign key (the service checks those links). Flags: rbac_v2_support,
-- rbac_v2_shop_change_requests (OFF). Rollback: scripts/rollback-0172.sql.
CREATE TABLE IF NOT EXISTS "staff_team_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "team" text NOT NULL CHECK ("team" IN ('SUPPORT','OPERATIONS')),
  "manager_user_id" uuid NOT NULL,
  "member_user_id" uuid NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "added_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_team_members_active_unique" ON "staff_team_members" ("team", "member_user_id") WHERE "active";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_team_members_manager_idx" ON "staff_team_members" ("manager_user_id", "team");
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "manager_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "sub_status" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_sub_status_valid') THEN
    ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_sub_status_valid"
      CHECK ("sub_status" IS NULL OR "sub_status" IN ('PENDING_INFORMATION','ON_HOLD','REJECTED'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "change_request_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "ops_task_id" uuid;
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "raised_by_staff" boolean;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_tickets_assignee_live_idx" ON "support_tickets" ("assigned_to_user_id", "status") WHERE "assigned_to_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_mrp_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "shop_product_id" uuid NOT NULL,
  "previous_mrp_paise" bigint,
  "new_mrp_paise" bigint NOT NULL CHECK ("new_mrp_paise" >= 0),
  "changed_by" uuid,
  "source" text NOT NULL CHECK ("source" IN ('OWNER','CHANGE_REQUEST','ADMIN')),
  "approval_request_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_mrp_history_product_idx" ON "shop_mrp_history" ("shop_product_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_mrp_history_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shop_mrp_history is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_mrp_history_append_only ON "shop_mrp_history";
--> statement-breakpoint
CREATE TRIGGER shop_mrp_history_append_only BEFORE UPDATE OR DELETE ON "shop_mrp_history"
  FOR EACH ROW EXECUTE FUNCTION shop_mrp_history_block_mutation();
