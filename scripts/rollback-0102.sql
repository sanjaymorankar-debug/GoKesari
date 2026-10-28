-- Rollback for 0102_feature_flags (docs/dealer-programme, step 1). Core database.
-- Run only after the previous release's code is live, then delete the 0102 row from
-- drizzle.__drizzle_migrations. The flag change log is lost — back up first.
BEGIN;
DROP TABLE IF EXISTS "feature_flag_changes";
DROP TABLE IF EXISTS "feature_flags";
COMMIT;
