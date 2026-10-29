-- Rollback for 0112_more_licences (docs/document-upload-2026-10, "More licences").
-- Seller database. Run only after the previous release's code is live, then delete the 0112 row
-- from drizzle.__drizzle_migrations. The optional licences (trade licence, legal metrology, fire
-- NOC, seeds / fertiliser / pesticide, Other licence) and their uploads are deleted — back up first.
-- FSSAI, drug licence and medical registration rows are kept.
BEGIN;
DELETE FROM "seller_document_uploads" WHERE "doc_type" IN ('TRADE_LICENCE', 'LEGAL_METROLOGY', 'FIRE_NOC', 'AGRI_INPUT_LICENCE', 'OTHER_LICENCE');
-- shop_legal_document_files rows go with their documents (ON DELETE CASCADE).
DELETE FROM "shop_legal_documents" WHERE "doc_type" IN ('TRADE_LICENCE', 'LEGAL_METROLOGY', 'FIRE_NOC', 'AGRI_INPUT_LICENCE', 'OTHER_LICENCE');
ALTER TABLE "seller_document_uploads" DROP CONSTRAINT IF EXISTS "seller_document_uploads_doc_type";
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_doc_type" CHECK ("seller_document_uploads"."doc_type" in ('PAN', 'GSTIN', 'UDYAM', 'FSSAI', 'SHOP_ACT', 'DRUG_LICENCE', 'MEDICAL_REGISTRATION'));
CREATE UNIQUE INDEX IF NOT EXISTS "shop_legal_documents_shop_type_uq" ON "shop_legal_documents" USING btree ("shop_id","doc_type");
DROP INDEX IF EXISTS "shop_legal_documents_shop_type_key_uq";
ALTER TABLE "shop_legal_documents" DROP COLUMN IF EXISTS "licence_key";
ALTER TABLE "shop_legal_documents" DROP COLUMN IF EXISTS "licence_name";
COMMIT;
