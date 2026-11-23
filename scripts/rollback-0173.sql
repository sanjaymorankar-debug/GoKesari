-- Rollback of drizzle/0173_rbac_v2_documents.sql. Export the documents first: this drops them and every version.
DROP TABLE IF EXISTS "staff_document_versions";
DROP FUNCTION IF EXISTS staff_document_versions_block_update();
DROP TABLE IF EXISTS "staff_documents";
