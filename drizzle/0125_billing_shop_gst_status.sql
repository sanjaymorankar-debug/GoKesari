-- split: seller
-- Billing v2, phase 1 (docs/billing): the shop's GST registration type (build prompt §3, gap G5).
-- REGULAR / COMPOSITION / ENROLMENT_ID / PAN_ONLY_SERVICE / UNREGISTERED, the Enrolment ID, the
-- GSTIN's portal status, its state and when it was last checked. ADDITIVE ONLY; idempotent.
-- Backfill from gst_status: REGISTERED with a GSTIN -> REGULAR, COMPOSITION -> COMPOSITION, else
-- UNREGISTERED (an unverified GSTIN is never treated as registered).
-- Rollback: scripts/rollback-0125.sql
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "gst_registration_type" text DEFAULT 'UNREGISTERED' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "gst_enrolment_id" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "gst_portal_status" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "gst_state_code" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "gst_portal_checked_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shops" ADD CONSTRAINT "shops_gst_registration_type_check"
    CHECK ("gst_registration_type" IN ('REGULAR', 'COMPOSITION', 'ENROLMENT_ID', 'PAN_ONLY_SERVICE', 'UNREGISTERED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shops" ADD CONSTRAINT "shops_gst_portal_status_check"
    CHECK ("gst_portal_status" IS NULL OR "gst_portal_status" IN ('ACTIVE', 'CANCELLED', 'SUSPENDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
UPDATE "shops"
   SET "gst_registration_type" = CASE
         WHEN "gst_status" = 'COMPOSITION' THEN 'COMPOSITION'
         WHEN "gst_status" = 'REGISTERED' AND "gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$' THEN 'REGULAR'
         ELSE 'UNREGISTERED' END,
       "gst_state_code" = COALESCE("gst_state_code", CASE WHEN "gstin" ~ '^[0-9]{2}' THEN substr("gstin", 1, 2) END)
 WHERE "gst_registration_type" = 'UNREGISTERED' AND "gst_portal_checked_at" IS NULL;
