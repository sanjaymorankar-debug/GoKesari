-- Rollback for 0061_legal_documents (docs/four-features-2026-10, feature 2).
-- Run only after the previous code is live, then delete the 0061 row from
-- drizzle.__drizzle_migrations. Uploaded licences are lost — back up first.
-- The "Doctor / Clinic" shop category is removed only while no shop uses it.
DROP TABLE IF EXISTS "shop_legal_document_files";
DROP TABLE IF EXISTS "shop_legal_documents";
DELETE FROM "shop_categories" c
 WHERE c."slug" = 'doctor-clinic'
   AND NOT EXISTS (SELECT 1 FROM "shop_category_mapping" m WHERE m."category_id" = c."id");
