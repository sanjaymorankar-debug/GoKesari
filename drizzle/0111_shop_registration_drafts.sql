-- split: seller
-- Onboarding wizard step 1 (docs/shop-onboarding-wizard-2026-10): a shop registration in
-- progress, before its shop row exists — the GSTIN checked first (its record fills the shop's
-- name and address) and the PAN inside it checked in the background, or PAN alone with the
-- "not GST-registered" declaration. Numbers stored as ciphertext, masked form and blind index
-- only. owner_id is a platform user: no foreign key across the split, checked in the service.
-- ADDITIVE ONLY; idempotent.
CREATE TABLE IF NOT EXISTS "shop_registration_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"route" text,
	"gstin_encrypted" text,
	"gstin_masked" text,
	"gstin_hash" text,
	"gst_status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"gst_record" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gst_provider_id" text,
	"gst_provider_ref" text,
	"gst_error_code" text,
	"gst_idempotency_key" text,
	"gst_checked_at" timestamp with time zone,
	"gst_verified_at" timestamp with time zone,
	"pan_encrypted" text,
	"pan_masked" text,
	"pan_hash" text,
	"pan_status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"pan_record" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pan_name_match_score" integer,
	"pan_provider_id" text,
	"pan_provider_ref" text,
	"pan_error_code" text,
	"pan_idempotency_key" text,
	"pan_checked_at" timestamp with time zone,
	"pan_verified_at" timestamp with time zone,
	"no_gst_declared_at" timestamp with time zone,
	"no_gst_declaration_version" text,
	"consent_given_at" timestamp with time zone,
	"consent_version" text,
	"check_window_started_at" timestamp with time zone,
	"checks_in_window" integer DEFAULT 0 NOT NULL,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_registration_drafts_status" CHECK ("status" in ('OPEN', 'SUBMITTED', 'ABANDONED')),
	CONSTRAINT "shop_registration_drafts_route" CHECK ("route" IS NULL OR "route" in ('GSTIN', 'PAN_ONLY')),
	CONSTRAINT "shop_registration_drafts_gst_status" CHECK ("gst_status" in ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW')),
	CONSTRAINT "shop_registration_drafts_pan_status" CHECK ("pan_status" in ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_registration_drafts_open_owner_unique" ON "shop_registration_drafts" ("owner_id") WHERE "status" = 'OPEN';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_drafts_gstin_hash_idx" ON "shop_registration_drafts" ("gstin_hash") WHERE "gstin_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_drafts_status_idx" ON "shop_registration_drafts" ("status", "updated_at");
