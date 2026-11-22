-- Rollback for 0162_shop_document_rules (DF-09, admin document rules).
-- Before running: deploy the previous release's code, then delete the 0162 row from
-- drizzle.__drizzle_migrations.
-- Documents shops uploaded for an admin-added document stay in shop_legal_documents as
-- "Other licence" rows (licence_key 'DOC:…'); only the rules and the document list go.
BEGIN;
DROP TABLE IF EXISTS "shop_document_rules";
DROP TABLE IF EXISTS "shop_document_types";
COMMIT;
