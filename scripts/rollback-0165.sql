-- Rollback for 0165_doctor_document_scope (H-52, medical registration for every doctor category).
-- Before running: deploy the previous release's code, then delete the 0165 row from
-- drizzle.__drizzle_migrations.
-- Removes every "Doctors" rule (the seeded one and any an admin added) and puts the scope check back.
-- Registrations shops uploaded stay in shop_legal_documents.
BEGIN;
DELETE FROM "shop_document_rules" WHERE "scope" = 'DOCTOR';
ALTER TABLE "shop_document_rules" DROP CONSTRAINT IF EXISTS "shop_document_rules_scope";
ALTER TABLE "shop_document_rules" ADD CONSTRAINT "shop_document_rules_scope" CHECK ("scope" = 'ALL' OR "scope" = 'FOOD' OR "scope" ~ '^TYPE:[A-Z0-9_]{2,60}$');
COMMIT;
