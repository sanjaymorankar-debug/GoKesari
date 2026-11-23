-- Rollback of drizzle/0176_society_join_requests.sql (docs/delta CF-006). Switch
-- society_rider_join_requests_enabled off first. Drops the join-request history only; riders
-- already approved stay on society_riders (they were listed through the normal rider list).
DROP TABLE IF EXISTS "society_join_requests";
DELETE FROM "feature_flag_changes" WHERE "flag_key" = 'society_rider_join_requests_enabled';
DELETE FROM "feature_flags" WHERE "key" = 'society_rider_join_requests_enabled';
