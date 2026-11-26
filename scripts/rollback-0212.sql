-- Rollback for drizzle/0212_seller_agreements.sql (docs/seller-agreements-2026-11).
-- WARNING: drops the signed-agreement evidence (legal_acceptances, legal_signed_files). Export it first
-- (Admin → Agreements → Acceptances → CSV, and the signed PDFs) and get the owner's OK.
BEGIN;
DROP TABLE IF EXISTS "legal_signed_files";
DROP TABLE IF EXISTS "legal_acceptances";
DROP TABLE IF EXISTS "legal_document_snapshots";
DROP TABLE IF EXISTS "legal_signing_requests";
DROP TABLE IF EXISTS "legal_shop_agreement_states";
DROP TABLE IF EXISTS "legal_platform_assets";
DROP TABLE IF EXISTS "legal_documents";
DROP TABLE IF EXISTS "legal_agreement_emails";
DELETE FROM "document_emails" WHERE "doc_type" = 'SELLER_AGREEMENTS';
DROP FUNCTION IF EXISTS "legal_records_immutable"();
ALTER TABLE "document_emails" DROP COLUMN IF EXISTS "message_id";
ALTER TABLE "document_emails" DROP COLUMN IF EXISTS "cc_addresses";
DELETE FROM "feature_flags" WHERE "key" = 'seller_agreements_enabled';
COMMIT;
