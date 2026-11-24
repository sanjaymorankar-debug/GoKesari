-- Rollback for 0194_users_preferred_lang (Module 6, Hindi and Marathi; docs/hindi-marathi-2026-11/).
-- Deploy the previous release's code first (it never reads the column), then run this and delete the 0194 row.
-- The gk_lang cookie keeps every visitor's language; notifications go back to English only.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_preferred_lang_check";
ALTER TABLE "users" DROP COLUMN IF EXISTS "preferred_lang";
