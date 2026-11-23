-- RBAC v2 (brief §9; docs/rbac/05-documents.md): documents Support / Operations keep for a shop or one of its products
-- (catalogues, price lists, specifications, certificates, agreements, photos, licences by shop type). ADDITIVE ONLY.
--  * staff_documents          one document: shop, optional product, type, verification status, links to ticket / change
--  * staff_document_versions  every upload is a new version (never overwritten: UPDATE is refused by trigger); bytes are
--                             kept in the database like the existing shop documents and served only through short-lived
--                             signed links. A document is removed only by an admin, after a second admin approves.
-- The existing shop_legal_documents / seller verification files are not touched. Flag: rbac_v2_support (OFF).
-- Rollback: scripts/rollback-0173.sql.
CREATE TABLE IF NOT EXISTS "staff_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "shop_product_id" uuid,
  "doc_type" text NOT NULL CHECK ("doc_type" IN ('GST_CERTIFICATE','PAN','SHOP_ACT','FSSAI','DRUG_LICENCE','OTHER_LICENCE','PRODUCT_CATALOGUE','PRODUCT_IMAGE','SPECIFICATION','PRICE_LIST','SHOP_PHOTO','AGREEMENT','CERTIFICATE','OTHER')),
  "title" text NOT NULL,
  "current_version" integer NOT NULL DEFAULT 1,
  "verification_status" text NOT NULL DEFAULT 'UNVERIFIED' CHECK ("verification_status" IN ('UNVERIFIED','VERIFIED','REJECTED')),
  "verified_by" uuid,
  "verified_at" timestamp with time zone,
  "ticket_id" uuid,
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','DELETED')),
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_by" uuid,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_documents_shop_idx" ON "staff_documents" ("shop_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_document_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES "staff_documents"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL CHECK ("size_bytes" > 0 AND "size_bytes" <= 20000000),
  "sha256" text NOT NULL,
  "data" bytea NOT NULL,
  "uploaded_by" uuid NOT NULL,
  "uploaded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "staff_document_versions_unique" UNIQUE ("document_id", "version")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION staff_document_versions_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_document_versions: a version is never changed; upload a new one' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS staff_document_versions_immutable ON "staff_document_versions";
--> statement-breakpoint
CREATE TRIGGER staff_document_versions_immutable BEFORE UPDATE ON "staff_document_versions"
  FOR EACH ROW EXECUTE FUNCTION staff_document_versions_block_update();
