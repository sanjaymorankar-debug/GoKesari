-- Medical registration for every doctor category, with or without the legalDocuments rule (owner,
-- 22-Nov-2026, H-52). Adds the "DOCTOR" scope to the admin's document rules (DF-09): a shop in any
-- shop category of a Health doctor group — General & family, Specialists, Women & child, Dental,
-- Eye & ENT, Mind, AYUSH, Animal care; not Therapy or Diagnostics (src/lib/health/specialties.ts).
-- Seeded on the owner's promise (owner, 22-Nov-2026 08.36 IST: "Keep as promise"); shops already live
-- get 90 days from this release (live_shops_due_at) before the follow-up may suspend them for it.
-- A shop-type rule still wins (Doctor's Clinic, Super Speciality Clinic and Professional office keep
-- theirs). An admin may change or remove the rule like any other.
-- Additive only. Rollback: scripts/rollback-0165.sql.
ALTER TABLE "shop_document_rules" DROP CONSTRAINT IF EXISTS "shop_document_rules_scope";
--> statement-breakpoint
ALTER TABLE "shop_document_rules" ADD CONSTRAINT "shop_document_rules_scope" CHECK ("scope" = 'ALL' OR "scope" = 'FOOD' OR "scope" = 'DOCTOR' OR "scope" ~ '^TYPE:[A-Z0-9_]{2,60}$');
--> statement-breakpoint
INSERT INTO "shop_document_rules" ("doc_key", "scope", "level", "live_shops_due_at", "note") VALUES
	('MEDICAL_REGISTRATION', 'DOCTOR', 'PROMISE', now() + interval '90 days', 'Owner, 22-Nov-2026 (H-52): every Health doctor category, on the owner''s promise.')
ON CONFLICT ("doc_key", "scope") DO NOTHING;
