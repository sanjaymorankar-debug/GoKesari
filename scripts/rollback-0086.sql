-- Rollback for 0086_home_banners_search (homepage UI/UX upgrade: hero banners, search log).
-- Run only after the previous release's code is live (the migration is
-- additive, so that code ignores these objects), then delete the 0086 row
-- from drizzle.__drizzle_migrations. Back up first:
-- Banners and the search history (recent / trending searches) are lost.
BEGIN;
DROP TABLE IF EXISTS "search_queries" CASCADE;
DROP TABLE IF EXISTS "home_banners" CASCADE;
COMMIT;
