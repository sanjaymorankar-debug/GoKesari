-- Rollback for 0103_geo_areas (docs/dealer-programme, step 1). Seller database.
-- Run only after the previous release's code is live, then delete the 0103 row from
-- drizzle.__drizzle_migrations. Areas and PIN prefixes added by admins are lost — back up first.
BEGIN;
DROP TABLE IF EXISTS "geo_area_pincodes";
DROP TABLE IF EXISTS "geo_areas";
COMMIT;
