-- split: core
-- Gig worker (delivery partner) flow, 31 Oct 2026 — docs/gig-worker-2026-10/README.md.
-- Core (customer) database only: delivery_partners and its new child tables are platform tables,
-- society_partner_access is a customer table, orders and delivery_proofs are core. Every change is
-- additive (new nullable columns, new columns with defaults, new tables), so the previous release
-- keeps working against it. Idempotent. Rollback: scripts/rollback-0121.sql

-- 1. Registration details (feature 1). Nullable: partners who registered before keep working.
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "gender" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "address_line" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "address_city" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "address_pincode" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "emergency_contact_name" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "emergency_contact_mobile" text;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "emergency_contact_relation" text;--> statement-breakpoint
-- When the device location was shared at sign-up (feature 4).
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "registration_location_at" timestamp with time zone;--> statement-breakpoint
-- The duplicate-mobile check looks partners up by mobile.
CREATE INDEX IF NOT EXISTS "delivery_partners_mobile_idx" ON "delivery_partners" ("mobile");--> statement-breakpoint

-- 2. Offline / Active / Ready (feature 5). is_online stays, kept equal to availability <> 'OFFLINE',
-- so the lifecycle trigger (0042) and every reader of is_online are unchanged. A partner online
-- today keeps receiving offers: they start READY.
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "availability" text DEFAULT 'OFFLINE' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partners" DROP CONSTRAINT IF EXISTS "delivery_partners_availability_check";--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD CONSTRAINT "delivery_partners_availability_check" CHECK ("availability" IN ('OFFLINE', 'ACTIVE', 'READY'));--> statement-breakpoint
UPDATE "delivery_partners" SET "availability" = 'READY' WHERE "is_online" AND "availability" = 'OFFLINE';--> statement-breakpoint
-- Admin override of the KYC / police-verification gate on the toggle.
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "availability_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "availability_override_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "availability_override_reason" text;--> statement-breakpoint

-- 3. PAN and Aadhaar checks with the KYC provider (feature 2). The Aadhaar number is never stored:
-- only a masked form and a keyed token (HMAC). The PAN is stored encrypted (AES-256-GCM).
CREATE TABLE IF NOT EXISTS "delivery_partner_kyc_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE cascade,
  "doc_type" text NOT NULL CHECK ("doc_type" IN ('PAN', 'AADHAAR')),
  "status" text DEFAULT 'PENDING' NOT NULL CHECK ("status" IN ('PENDING', 'VERIFIED', 'FAILED')),
  "number_masked" text NOT NULL,
  "number_token" text NOT NULL,
  "number_encrypted" text,
  "name_on_record" text,
  "name_match_score" integer,
  "provider" text NOT NULL,
  "provider_ref" text,
  "otp_reference" text,
  "otp_requested_at" timestamp with time zone,
  "otp_attempts" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "consent_version" text NOT NULL,
  "consent_given_at" timestamp with time zone NOT NULL,
  "consent_ip" text,
  "verified_at" timestamp with time zone,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "delivery_partner_kyc_checks_aadhaar_never_stored" CHECK ("doc_type" <> 'AADHAAR' OR "number_encrypted" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_partner_kyc_checks_partner_doc_unique" ON "delivery_partner_kyc_checks" ("delivery_partner_id", "doc_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_partner_kyc_checks_token_idx" ON "delivery_partner_kyc_checks" ("doc_type", "number_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_partner_kyc_checks_status_idx" ON "delivery_partner_kyc_checks" ("status");--> statement-breakpoint

-- 4. Police verification form and character certificate (feature 3): the file, encrypted, in the
-- database (never a public bucket); an admin moves it Uploaded → Under review → Approved / Rejected.
CREATE TABLE IF NOT EXISTS "delivery_partner_background_docs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE cascade,
  "doc_type" text NOT NULL CHECK ("doc_type" IN ('POLICE_VERIFICATION', 'CHARACTER_CERTIFICATE')),
  "status" text DEFAULT 'UPLOADED' NOT NULL CHECK ("status" IN ('UPLOADED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')),
  "rejection_reason" text,
  "content_type" text NOT NULL CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png')),
  "size_bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "data_encrypted" bytea NOT NULL,
  "uploaded_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "reviewed_at" timestamp with time zone,
  "replaced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_partner_background_docs_partner_idx" ON "delivery_partner_background_docs" ("delivery_partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_partner_background_docs_current_unique" ON "delivery_partner_background_docs" ("delivery_partner_id", "doc_type") WHERE "replaced_at" IS NULL;--> statement-breakpoint

-- 5. Admin authorise / block of a partner per society (features 7 and 8).
CREATE TABLE IF NOT EXISTS "society_partner_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "society_id" uuid NOT NULL REFERENCES "societies"("id") ON DELETE cascade,
  "delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE cascade,
  "access" text NOT NULL CHECK ("access" IN ('AUTHORISED', 'BLOCKED')),
  "reason" text,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "society_partner_access_unique" ON "society_partner_access" ("society_id", "delivery_partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "society_partner_access_partner_idx" ON "society_partner_access" ("delivery_partner_id", "access");--> statement-breakpoint

-- 6. Optional photo at pickup (feature 9): delivery_proofs rows are now PICKUP or DELIVERY.
ALTER TABLE "delivery_proofs" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'DELIVERY' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_proofs" DROP CONSTRAINT IF EXISTS "delivery_proofs_kind_check";--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_kind_check" CHECK ("kind" IN ('PICKUP', 'DELIVERY'));--> statement-breakpoint

-- 7. Completed (feature 11): set once a delivered order is confirmed complete. The order status
-- stays DELIVERED, which returns, ratings, invoices and refunds key on.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
