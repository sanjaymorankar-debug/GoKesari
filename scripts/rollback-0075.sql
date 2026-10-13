-- Rollback for 0075_seller_document_uploads (docs/document-upload-2026-10).
-- Run only after the previous code is live, then delete the 0075 row from
-- drizzle.__drizzle_migrations (the newest row). Drafts and their read fields
-- are lost — back up first. Documents the owners confirmed stay in
-- seller_verifications / shop_legal_documents and their file tables.
DROP TABLE IF EXISTS "seller_document_uploads";
