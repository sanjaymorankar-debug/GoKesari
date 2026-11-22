-- Rollback of drizzle/0175_rbac_v2_operations.sql (RBAC v2 Phase 6, Operations).
-- First line of rollback is the flag: switch rbac_v2_operations OFF (nothing else changes).
-- Use this script only after the code is reverted. Export the history first if it must be kept:
--   \copy ops_task_events TO 'ops_task_events.csv' CSV HEADER
DROP TABLE IF EXISTS "ops_customer_assists";
DROP TABLE IF EXISTS "ops_task_events";
DROP FUNCTION IF EXISTS ops_task_events_block_mutation();
DROP TABLE IF EXISTS "ops_tasks";
DROP TABLE IF EXISTS "ops_zone_assignments";
