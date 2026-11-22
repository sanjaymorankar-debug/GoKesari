-- Rollback of drizzle/0172_rbac_v2_support_changes.sql. Switch rbac_v2_support and rbac_v2_shop_change_requests off first.
-- Drops the team table and the shop MRP history (export it first; the live shop MRP itself is untouched) and the
-- new support_tickets columns (their values are lost; tickets themselves stay).
DROP TABLE IF EXISTS "shop_mrp_history";
DROP FUNCTION IF EXISTS shop_mrp_history_block_mutation();
DROP TABLE IF EXISTS "staff_team_members";
DROP INDEX IF EXISTS "support_tickets_assignee_live_idx";
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_sub_status_valid";
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "raised_by_staff";
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "ops_task_id";
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "change_request_id";
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "sub_status";
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "manager_user_id";
