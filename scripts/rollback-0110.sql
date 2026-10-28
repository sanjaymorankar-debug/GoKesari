-- Rollback for 0110_geo_area_targets (docs/dealer-programme, step 8). Seller database.
-- Run only after the previous release's code is live, then delete the 0110 row from
-- drizzle.__drizzle_migrations. The area targets are lost (export them first). Run before
-- rollback-0109.sql.
BEGIN;
DROP TABLE IF EXISTS "geo_area_targets";
COMMIT;
