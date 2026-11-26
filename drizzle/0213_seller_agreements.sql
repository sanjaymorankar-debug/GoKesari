-- Seller agreements: personalised, OTP-signed Seller SLA and Medical Onboarding Agreement, signed copies in
-- English / Marathi / Hindi, an immutable acceptance record and the signed-copy e-mail
-- (docs/seller-agreements-2026-11/README.md, owner brief 26-Nov-2026).
--
-- * legal_documents: the admin-managed, versioned templates (one row per document type, language and version).
-- * legal_document_snapshots: the shop data an agreement was filled with (JSON + SHA-256), frozen at signing.
-- * legal_signing_requests: one signing event (owner self-service, or a link sent when staff / a dealer
--   registered the shop on the owner's behalf).
-- * legal_acceptances: one row per document accepted. IMMUTABLE: a trigger refuses every UPDATE and DELETE.
-- * legal_signed_files: the signed PDFs (encrypted at rest), also immutable.
-- * legal_shop_agreement_states: per shop, since when a signature is required and when the 7-day grace ends.
-- * legal_platform_assets: the company e-seal image the admin uploads.
-- * legal_agreement_emails: one row per signed-copy e-mail (first send and every Resend); delivered through
--   document_emails (retries, Message-ID, status) with doc_type SELLER_AGREEMENTS.
-- * document_emails + message_id, cc_addresses (the signed-copy e-mail is copied to ceo@agtci.com).
-- * feature flag seller_agreements_enabled (OFF).
--
-- No foreign keys to shops / users (the evidence outlives a deleted shop or account), as for user_consents.
-- Times are timestamptz (absolute instants); every screen, PDF and e-mail shows them in IST.
-- Additive. Rollback: scripts/rollback-0213.sql.
CREATE TABLE IF NOT EXISTS "legal_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "doc_type" text NOT NULL,
  "applies_to_shop_types" text[] DEFAULT '{}'::text[] NOT NULL,
  "language" text NOT NULL,
  "version" text NOT NULL,
  "effective_date" date NOT NULL,
  "title" text NOT NULL,
  "template_body" text NOT NULL,
  "letterhead_template" text DEFAULT 'agt-letterhead-v1' NOT NULL,
  "template_sha256" text NOT NULL,
  "source_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "review_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
  "review_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "change_summary" text,
  "requires_resign" boolean DEFAULT true NOT NULL,
  "notice_sent_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "published_by" uuid,
  "published_at" timestamp with time zone,
  "retired_by" uuid,
  "retired_at" timestamp with time zone,
  CONSTRAINT "legal_documents_doc_type_check" CHECK ("doc_type" IN ('SELLER_SLA', 'MEDICAL_ONBOARDING', 'TERMS_OF_USE', 'PRIVACY_POLICY')),
  CONSTRAINT "legal_documents_language_check" CHECK ("language" IN ('en', 'mr', 'hi')),
  CONSTRAINT "legal_documents_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  CONSTRAINT "legal_documents_review_status_check" CHECK ("review_status" IN ('NOT_REQUIRED', 'PENDING_LEGAL_REVIEW', 'REVIEWED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_documents_type_lang_version_uq" ON "legal_documents" ("doc_type", "language", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_documents_status_idx" ON "legal_documents" ("doc_type", "status", "effective_date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_document_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "data" jsonb NOT NULL,
  "data_sha256" text NOT NULL,
  "material_fingerprint" text NOT NULL,
  "licence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "licences_as_of" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_document_snapshots_shop_idx" ON "legal_document_snapshots" ("shop_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_signing_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "initiated_by_user_id" uuid,
  "initiated_as" text DEFAULT 'SELF' NOT NULL,
  "link_token_hash" text,
  "link_expires_at" timestamp with time zone,
  "link_sent_at" timestamp with time zone,
  "snapshot_id" uuid,
  "otp_id" uuid,
  "signed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_signing_requests_reason_check" CHECK ("reason" IN ('REGISTRATION', 'EXISTING_SHOP', 'NEW_VERSION', 'ANNEXURE_UPDATE')),
  CONSTRAINT "legal_signing_requests_status_check" CHECK ("status" IN ('OPEN', 'SIGNED', 'CANCELLED', 'EXPIRED')),
  CONSTRAINT "legal_signing_requests_initiated_as_check" CHECK ("initiated_as" IN ('SELF', 'ADMIN', 'OPERATOR', 'DEALER'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_signing_requests_token_uq" ON "legal_signing_requests" ("link_token_hash") WHERE "link_token_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_signing_requests_shop_idx" ON "legal_signing_requests" ("shop_id", "status", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "signing_request_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "legal_document_id" uuid,
  "doc_type" text NOT NULL,
  "version" text NOT NULL,
  "language_viewed" text NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "app_platform" text NOT NULL,
  "otp_verification_ref" uuid,
  "signer_name" text NOT NULL,
  "signer_designation" text NOT NULL,
  "data_snapshot_id" uuid,
  "licence_ids_included" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "signed_pdf_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "certified_pdf_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "template_sha256" text,
  "registered_by_role" text DEFAULT 'SELF' NOT NULL,
  "registered_by_user_id" uuid,
  "geo_location" jsonb,
  "verify_code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_acceptances_platform_check" CHECK ("app_platform" IN ('web', 'android', 'ios')),
  CONSTRAINT "legal_acceptances_language_check" CHECK ("language_viewed" IN ('en', 'mr', 'hi')),
  CONSTRAINT "legal_acceptances_registered_by_check" CHECK ("registered_by_role" IN ('SELF', 'ADMIN', 'OPERATOR', 'DEALER'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_acceptances_verify_code_uq" ON "legal_acceptances" ("verify_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_acceptances_shop_idx" ON "legal_acceptances" ("shop_id", "accepted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_acceptances_doc_idx" ON "legal_acceptances" ("doc_type", "version", "accepted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_acceptances_request_idx" ON "legal_acceptances" ("signing_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_signed_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "acceptance_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "legal_document_id" uuid,
  "language" text NOT NULL,
  "kind" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "data_encrypted" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_signed_files_kind_check" CHECK ("kind" IN ('SIGNED', 'CERTIFIED')),
  CONSTRAINT "legal_signed_files_language_check" CHECK ("language" IN ('en', 'mr', 'hi'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_signed_files_acceptance_lang_kind_uq" ON "legal_signed_files" ("acceptance_id", "language", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_signed_files_sha_idx" ON "legal_signed_files" ("sha256");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "legal_records_immutable"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is an immutable legal record: rows cannot be changed or deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "legal_acceptances_immutable" ON "legal_acceptances";
--> statement-breakpoint
CREATE TRIGGER "legal_acceptances_immutable" BEFORE UPDATE OR DELETE ON "legal_acceptances" FOR EACH ROW EXECUTE FUNCTION "legal_records_immutable"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "legal_signed_files_immutable" ON "legal_signed_files";
--> statement-breakpoint
CREATE TRIGGER "legal_signed_files_immutable" BEFORE UPDATE OR DELETE ON "legal_signed_files" FOR EACH ROW EXECUTE FUNCTION "legal_records_immutable"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "legal_document_snapshots_immutable" ON "legal_document_snapshots";
--> statement-breakpoint
CREATE TRIGGER "legal_document_snapshots_immutable" BEFORE UPDATE OR DELETE ON "legal_document_snapshots" FOR EACH ROW EXECUTE FUNCTION "legal_records_immutable"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_shop_agreement_states" (
  "shop_id" uuid PRIMARY KEY NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "required_since" timestamp with time zone NOT NULL,
  "grace_until" timestamp with time zone NOT NULL,
  "reminder_sent_at" timestamp with time zone,
  "last_signing_request_id" uuid,
  "satisfied_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_shop_agreement_states_open_idx" ON "legal_shop_agreement_states" ("grace_until") WHERE "satisfied_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_platform_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "content_type" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "data" bytea NOT NULL,
  "uploaded_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_platform_assets_kind_check" CHECK ("kind" IN ('E_SEAL')),
  CONSTRAINT "legal_platform_assets_type_check" CHECK ("content_type" IN ('image/png', 'image/jpeg')),
  CONSTRAINT "legal_platform_assets_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 1000000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_agreement_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "signing_request_id" uuid NOT NULL,
  "shop_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "include_banners" boolean DEFAULT false NOT NULL,
  "requested_by" uuid,
  "attachments" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legal_agreement_emails_kind_check" CHECK ("kind" IN ('SIGNED_COPY', 'RESEND'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_agreement_emails_request_idx" ON "legal_agreement_emails" ("signing_request_id", "created_at");
--> statement-breakpoint
ALTER TABLE "document_emails" ADD COLUMN IF NOT EXISTS "message_id" text;
--> statement-breakpoint
ALTER TABLE "document_emails" ADD COLUMN IF NOT EXISTS "cc_addresses" text[];
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('seller_agreements_enabled', false) ON CONFLICT DO NOTHING;
