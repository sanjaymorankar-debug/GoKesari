-- Shop document rules (owner, 22-Nov-2026, DF-09): an admin sets each licence / legal document as
-- must-have before go-live, upload later on the owner's promise, or optional — for all shops, shops
-- that sell food, or one shop type — and may add a document the law newly requires.
-- GSTIN or PAN is not part of these rules (it stays a must-have, DF-08).
-- Seeded with today's behaviour (DF-08): FSSAI must-have for food shops; Shop Act on the promise for
-- every shop; Udyam optional; a pharmacy's drug licence and a clinic's / professional's registration
-- on the promise. The licence rows give shops already live 90 days from this release
-- (live_shops_due_at) before the follow-up may suspend them for it.
-- created_by / updated_by are platform users: no foreign keys (seller and customer tables have none
-- between them).
-- Additive only. Rollback: scripts/rollback-0163.sql.
CREATE TABLE IF NOT EXISTS "shop_document_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"label_hi" text,
	"label_mr" text,
	"law_note" text NOT NULL,
	"needs_number" boolean DEFAULT true NOT NULL,
	"needs_expiry" boolean DEFAULT false NOT NULL,
	"needs_authority" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_document_types_key_format" CHECK ("key" ~ '^DOC:[A-Z0-9][A-Z0-9-]{1,59}$'),
	CONSTRAINT "shop_document_types_status" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_document_types_label_uq" ON "shop_document_types" USING btree (lower("label"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_document_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_key" text NOT NULL,
	"scope" text NOT NULL,
	"level" text NOT NULL,
	"live_shops_due_at" timestamp with time zone,
	"note" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_document_rules_level" CHECK ("level" IN ('MUST_HAVE', 'PROMISE', 'OPTIONAL')),
	CONSTRAINT "shop_document_rules_scope" CHECK ("scope" = 'ALL' OR "scope" = 'FOOD' OR "scope" ~ '^TYPE:[A-Z0-9_]{2,60}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_document_rules_doc_scope_uq" ON "shop_document_rules" USING btree ("doc_key", "scope");
--> statement-breakpoint
INSERT INTO "shop_document_rules" ("doc_key", "scope", "level", "live_shops_due_at", "note") VALUES
	('FSSAI', 'FOOD', 'MUST_HAVE', NULL, 'DF-08 (owner, 21-Nov-2026): FSSAI is a must-have for food shops.'),
	('SHOP_ACT', 'ALL', 'PROMISE', NULL, 'DF-08: on the owner''s promise.'),
	('UDYAM', 'ALL', 'OPTIONAL', NULL, 'Optional, as before.'),
	('DRUG_LICENCE', 'TYPE:PHARMACY', 'PROMISE', now() + interval '90 days', 'DF-08 / owner 22-Nov-2026: on the owner''s promise.'),
	('MEDICAL_REGISTRATION', 'TYPE:DOCTOR_CLINIC', 'PROMISE', now() + interval '90 days', 'DF-08 / owner 22-Nov-2026: on the owner''s promise.'),
	('MEDICAL_REGISTRATION', 'TYPE:SUPER_SPECIALITY_CLINIC', 'PROMISE', now() + interval '90 days', 'DF-08 / owner 22-Nov-2026: on the owner''s promise.'),
	('MEDICAL_REGISTRATION', 'TYPE:PROFESSIONAL_OFFICE', 'PROMISE', now() + interval '90 days', 'DF-08 / owner 22-Nov-2026: on the owner''s promise.')
ON CONFLICT ("doc_key", "scope") DO NOTHING;
