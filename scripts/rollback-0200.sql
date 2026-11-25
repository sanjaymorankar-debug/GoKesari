-- Rollback for 0200_gokesari_books (docs/tax-register/BOOKS.md).
-- Before running: deploy the previous release's code, then delete the 0200 row from
-- drizzle.__drizzle_migrations. Journal drafts already made from postings stay.
BEGIN;
DROP TABLE IF EXISTS "fin_auto_postings";
DELETE FROM "feature_flags" WHERE "key" = 'auto_journals';
COMMIT;
