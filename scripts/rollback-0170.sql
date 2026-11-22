-- Rollback of drizzle/0170_rbac_v2_foundation.sql. Switch every rbac_v2_* flag off first.
-- Drops the approval engine tables (their history is lost — export approval_decisions first) and the
-- flag rows. The five user_role values cannot be removed from a PostgreSQL enum; with the flags off
-- and no user holding them they are inert. role_scope is left (nullable, unused when flags are off).
DROP TABLE IF EXISTS "approval_decisions";
DROP FUNCTION IF EXISTS approval_decisions_block_mutation();
DROP TABLE IF EXISTS "approval_request_items";
DROP TABLE IF EXISTS "approval_requests";
DELETE FROM "feature_flag_changes" WHERE "flag_key" LIKE 'rbac_v2_%';
DELETE FROM "feature_flags" WHERE "key" LIKE 'rbac_v2_%';
