-- split: seller
-- More licences on "Upload your documents" (docs/document-upload-2026-10, "More licences"):
-- trade licence (municipal), weights & measures (legal metrology), fire NOC, seeds / fertiliser /
-- pesticide licence, and "Other licence" with a name the owner types.
--   * shop_legal_documents.licence_name — the name of an Other licence.
--   * shop_legal_documents.licence_key — '' for every other type; the upper-cased name for an
--     Other licence, so a shop can hold several. The unique key becomes (shop, type, licence_key);
--     every existing row gets '' and keeps its one row per type.
--   * seller_document_uploads accepts the new document types.
-- ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0112.sql
ALTER TABLE "shop_legal_documents" ADD COLUMN IF NOT EXISTS "licence_name" text;--> statement-breakpoint
ALTER TABLE "shop_legal_documents" ADD COLUMN IF NOT EXISTS "licence_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_legal_documents_shop_type_key_uq" ON "shop_legal_documents" USING btree ("shop_id","doc_type","licence_key");--> statement-breakpoint
DROP INDEX IF EXISTS "shop_legal_documents_shop_type_uq";--> statement-breakpoint
ALTER TABLE "seller_document_uploads" DROP CONSTRAINT IF EXISTS "seller_document_uploads_doc_type";--> statement-breakpoint
ALTER TABLE "seller_document_uploads" ADD CONSTRAINT "seller_document_uploads_doc_type" CHECK ("seller_document_uploads"."doc_type" in ('PAN', 'GSTIN', 'UDYAM', 'FSSAI', 'SHOP_ACT', 'DRUG_LICENCE', 'MEDICAL_REGISTRATION', 'TRADE_LICENCE', 'LEGAL_METROLOGY', 'FIRE_NOC', 'AGRI_INPUT_LICENCE', 'OTHER_LICENCE'));
