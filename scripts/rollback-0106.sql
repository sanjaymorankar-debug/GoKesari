-- Rollback for 0106_shop_auto_approval_log (docs/dealer-programme, step 4). Seller database.
-- Run only after the previous release's code is live, then delete the 0106 row from
-- drizzle.__drizzle_migrations. The log of instant approvals and their evidence is lost — back
-- up first (the approvals themselves stay: shops keep their status). Run before rollback-0105.sql.
BEGIN;
DROP TABLE IF EXISTS "shop_auto_approval_log";
COMMIT;
