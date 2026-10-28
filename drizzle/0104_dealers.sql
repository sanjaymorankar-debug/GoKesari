-- split: seller
-- Dealer programme step 2 (docs/dealer-programme, GKS-DR-001…004): dealers, their documents,
-- codes, employees (salespeople) and territories. ADDITIVE ONLY; every statement is idempotent.
-- Owner, 28 Oct 2026: a distributor IS a dealer and keeps its code; its employees are told apart
-- by an optional Employee ID. The legacy step at the end makes every distributor a dealer and
-- links every existing referral code to a dealer WITHOUT changing the referral_codes rows, so
-- codes keep validating exactly as before.
-- user ids (users is a core table) are plain uuid columns without a foreign key.
CREATE TABLE IF NOT EXISTS "dealers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"legal_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"dealer_type" text NOT NULL,
	"mobile_e164" text,
	"mobile_verified_at" timestamp with time zone,
	"mobile_verification_method" text,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"pan_enc" text,
	"pan_hash" text,
	"pan_last4" text,
	"gstin" text,
	"shop_act_number" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"pincode" text,
	"state" text,
	"bank_holder_name" text,
	"bank_account_enc" text,
	"bank_account_last4" text,
	"bank_ifsc" text,
	"bank_status" text DEFAULT 'NOT_PROVIDED' NOT NULL,
	"bank_status_reason" text,
	"bank_verified_at" timestamp with time zone,
	"bank_check_ref" text,
	"agreement_version" text,
	"agreement_accepted_at" timestamp with time zone,
	"agreement_start" date,
	"agreement_end" date,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"status_reason" text,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"is_internal" boolean DEFAULT false NOT NULL,
	"legacy_distributor_id" uuid REFERENCES "distributors"("id") ON DELETE SET NULL,
	"source" text DEFAULT 'APPLICATION' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealers_type" CHECK ("dealer_type" in ('INDIVIDUAL', 'PROPRIETORSHIP', 'PARTNERSHIP', 'COMPANY')),
	CONSTRAINT "dealers_status" CHECK ("status" in ('DRAFT', 'PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED', 'TERMINATED')),
	CONSTRAINT "dealers_bank_status" CHECK ("bank_status" in ('NOT_PROVIDED', 'PENDING', 'VERIFIED', 'FAILED')),
	CONSTRAINT "dealers_mobile_method" CHECK ("mobile_verification_method" IS NULL OR "mobile_verification_method" in ('OTP', 'ADMIN_CALL', 'LEGACY')),
	CONSTRAINT "dealers_source" CHECK ("source" in ('APPLICATION', 'LEGACY_MIGRATION', 'ADMIN')),
	CONSTRAINT "dealers_agreement_dates" CHECK ("agreement_end" IS NULL OR "agreement_start" IS NULL OR "agreement_end" >= "agreement_start")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_user_unique" ON "dealers" ("user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_legacy_distributor_unique" ON "dealers" ("legacy_distributor_id") WHERE "legacy_distributor_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_internal_unique" ON "dealers" ("is_internal") WHERE "is_internal";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_pan_unique" ON "dealers" ("pan_hash") WHERE "pan_hash" IS NOT NULL AND "status" <> 'REJECTED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealers_status_idx" ON "dealers" ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_document_requirements" (
	"dealer_type" text NOT NULL,
	"doc_type" text NOT NULL,
	"required" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_document_requirements_pk" PRIMARY KEY ("dealer_type", "doc_type"),
	CONSTRAINT "dealer_document_requirements_type" CHECK ("dealer_type" in ('INDIVIDUAL', 'PROPRIETORSHIP', 'PARTNERSHIP', 'COMPANY')),
	CONSTRAINT "dealer_document_requirements_doc" CHECK ("doc_type" in ('PAN', 'GSTIN', 'SHOP_ACT', 'ADDRESS_PROOF', 'BANK_PROOF', 'AGREEMENT'))
);--> statement-breakpoint
INSERT INTO "dealer_document_requirements" ("dealer_type", "doc_type", "required") VALUES
	('INDIVIDUAL', 'PAN', true), ('INDIVIDUAL', 'GSTIN', false), ('INDIVIDUAL', 'SHOP_ACT', false),
	('INDIVIDUAL', 'ADDRESS_PROOF', true), ('INDIVIDUAL', 'BANK_PROOF', true), ('INDIVIDUAL', 'AGREEMENT', false),
	('PROPRIETORSHIP', 'PAN', true), ('PROPRIETORSHIP', 'GSTIN', false), ('PROPRIETORSHIP', 'SHOP_ACT', true),
	('PROPRIETORSHIP', 'ADDRESS_PROOF', true), ('PROPRIETORSHIP', 'BANK_PROOF', true), ('PROPRIETORSHIP', 'AGREEMENT', false),
	('PARTNERSHIP', 'PAN', true), ('PARTNERSHIP', 'GSTIN', false), ('PARTNERSHIP', 'SHOP_ACT', true),
	('PARTNERSHIP', 'ADDRESS_PROOF', true), ('PARTNERSHIP', 'BANK_PROOF', true), ('PARTNERSHIP', 'AGREEMENT', false),
	('COMPANY', 'PAN', true), ('COMPANY', 'GSTIN', true), ('COMPANY', 'SHOP_ACT', false),
	('COMPANY', 'ADDRESS_PROOF', true), ('COMPANY', 'BANK_PROOF', true), ('COMPANY', 'AGREEMENT', false)
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"doc_type" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" bytea NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_documents_doc" CHECK ("doc_type" in ('PAN', 'GSTIN', 'SHOP_ACT', 'ADDRESS_PROOF', 'BANK_PROOF', 'AGREEMENT')),
	CONSTRAINT "dealer_documents_status" CHECK ("status" in ('SUBMITTED', 'ACCEPTED', 'REJECTED')),
	CONSTRAINT "dealer_documents_size" CHECK ("size_bytes" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_documents_dealer_idx" ON "dealer_documents" ("dealer_id", "doc_type");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_territories" (
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"area_code" text NOT NULL REFERENCES "geo_areas"("code") ON DELETE RESTRICT,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_territories_pk" PRIMARY KEY ("dealer_id", "area_code")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_territories_area_idx" ON "dealer_territories" ("area_code");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_salespeople" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"employee_id" text NOT NULL,
	"name" text NOT NULL,
	"mobile_e164" text,
	"user_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"source" text DEFAULT 'DEALER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "dealer_salespeople_status" CHECK ("status" in ('ACTIVE', 'INACTIVE')),
	CONSTRAINT "dealer_salespeople_source" CHECK ("source" in ('DEALER', 'ADMIN', 'LEGACY_MIGRATION')),
	CONSTRAINT "dealer_salespeople_employee_id" CHECK (char_length("employee_id") BETWEEN 1 AND 48)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_salespeople_employee_unique" ON "dealer_salespeople" ("dealer_id", lower("employee_id"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL REFERENCES "referral_codes"("id") ON DELETE CASCADE,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"salesperson_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_codes_kind" CHECK ("kind" in ('DEALER', 'SALESPERSON', 'LEGACY')),
	CONSTRAINT "dealer_codes_status" CHECK ("status" in ('ACTIVE', 'SUSPENDED', 'REPLACED', 'RETIRED'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_codes_referral_code_unique" ON "dealer_codes" ("referral_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_codes_dealer_idx" ON "dealer_codes" ("dealer_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_codes_salesperson_idx" ON "dealer_codes" ("salesperson_id") WHERE "salesperson_id" IS NOT NULL;--> statement-breakpoint
-- Legacy (owner, 28 Oct 2026). 1. Every distributor becomes a dealer (approved when active).
INSERT INTO "dealers" ("user_id", "legal_name", "contact_name", "dealer_type", "mobile_e164", "mobile_verification_method", "email", "status", "legacy_distributor_id", "source", "decided_at")
SELECT d."user_id", d."name", d."name", 'PROPRIETORSHIP', d."phone_e164", CASE WHEN d."phone_e164" IS NULL THEN NULL ELSE 'LEGACY' END, d."email",
       CASE WHEN d."status" = 'ACTIVE' THEN 'APPROVED' ELSE 'SUSPENDED' END, d."id", 'LEGACY_MIGRATION', now()
  FROM "distributors" d
 WHERE NOT EXISTS (SELECT 1 FROM "dealers" x WHERE x."legacy_distributor_id" = d."id")
   AND (d."user_id" IS NULL OR NOT EXISTS (SELECT 1 FROM "dealers" y WHERE y."user_id" = d."user_id"));--> statement-breakpoint
-- 2. GoKesari Direct: the internal dealer that holds codes with no distributor. Earns nothing.
INSERT INTO "dealers" ("legal_name", "contact_name", "dealer_type", "status", "is_internal", "source", "decided_at")
SELECT 'GoKesari Direct', 'GoKesari', 'COMPANY', 'APPROVED', true, 'LEGACY_MIGRATION', now()
 WHERE NOT EXISTS (SELECT 1 FROM "dealers" WHERE "is_internal");--> statement-breakpoint
-- 3. A code with no distributor but a referrer's name: that person becomes a GoKesari Direct employee.
INSERT INTO "dealer_salespeople" ("dealer_id", "employee_id", "name", "status", "source")
SELECT gd."id", 'LEGACY-' || rc."code", rc."referrer_name", CASE WHEN rc."status" = 'ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END, 'LEGACY_MIGRATION'
  FROM "referral_codes" rc
  JOIN "dealers" gd ON gd."is_internal"
 WHERE rc."distributor_id" IS NULL
   AND nullif(trim(rc."referrer_name"), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "dealer_codes" dc WHERE dc."referral_code_id" = rc."id")
   AND NOT EXISTS (SELECT 1 FROM "dealer_salespeople" s WHERE s."dealer_id" = gd."id" AND lower(s."employee_id") = lower('LEGACY-' || rc."code"));--> statement-breakpoint
-- 4. Every existing referral code is linked to its dealer (and employee). The code row is not touched.
INSERT INTO "dealer_codes" ("referral_code_id", "dealer_id", "salesperson_id", "kind", "status")
SELECT rc."id", COALESCE(dd."id", gd."id"), s."id", 'LEGACY', CASE WHEN rc."status" = 'ACTIVE' THEN 'ACTIVE' ELSE 'RETIRED' END
  FROM "referral_codes" rc
  JOIN "dealers" gd ON gd."is_internal"
  LEFT JOIN "dealers" dd ON dd."legacy_distributor_id" = rc."distributor_id"
  LEFT JOIN "dealer_salespeople" s ON rc."distributor_id" IS NULL AND s."dealer_id" = gd."id" AND lower(s."employee_id") = lower('LEGACY-' || rc."code")
 WHERE NOT EXISTS (SELECT 1 FROM "dealer_codes" dc WHERE dc."referral_code_id" = rc."id");
