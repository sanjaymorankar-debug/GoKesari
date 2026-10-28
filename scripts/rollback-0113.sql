-- Rollback for 0113_india_states (docs/dealer-programme, all-India). Seller database.
-- Run only after the previous release's code is live, then delete the 0113 row from
-- drizzle.__drizzle_migrations. Removes the states other than Maharashtra and the state-level
-- PIN prefixes; refused (foreign keys) while a district, territory or target still uses a state —
-- remove those first. Run before rollback-0112.sql.
BEGIN;
DELETE FROM "geo_area_pincodes" WHERE length("pincode_prefix") <= 3 AND "area_code" IN (SELECT "code" FROM "geo_areas" WHERE "level" = 'STATE');
DELETE FROM "geo_areas" WHERE "level" = 'STATE' AND "code" <> 'MH';
COMMIT;
