-- Rollback for 0116_shop_document_promise (docs/shop-documents-2026-10).
-- Seller database. Run only after the previous release's code is live, then delete the 0116 row
-- from drizzle.__drizzle_migrations. Documents promises and the reminder count are lost: shops
-- that promised their documents stay as they are (pending or live), and reminders start again
-- from the first if the migration is applied again.
BEGIN;
DROP TABLE IF EXISTS "shop_document_reminders";
ALTER TABLE "shop_registration_drafts"
  DROP COLUMN IF EXISTS "documents_promised_at",
  DROP COLUMN IF EXISTS "has_shop_act";
ALTER TABLE "shops"
  DROP COLUMN IF EXISTS "documents_due_at",
  DROP COLUMN IF EXISTS "documents_promised_at";
COMMIT;
