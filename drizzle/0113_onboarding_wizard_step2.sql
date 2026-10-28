-- split: seller
-- Onboarding wizard step 2 (docs/shop-onboarding-wizard-2026-10):
--   1. The draft gains the shop details, the Udyam / FSSAI answers, the map pin and the
--      SUBMITTED → COMPLETED stages; its Udyam, FSSAI and Shop Act checks live in
--      shop_registration_draft_checks (one row per document, numbers as ciphertext,
--      masked form and blind index, like seller_verifications).
--   2. Owner decision B (28 Oct 2026): a wizard shop goes live right after payment with its
--      Shop Act — and, on the no-GSTIN route, its "not GST-registered" declaration — still
--      waiting for an admin's review. Each such document is listed in
--      shop_deferred_document_reviews; shop_kyc_complete() (0051, 0109) counts a listed
--      document as done while it is PENDING or MANUAL_REVIEW. A document the admin rejects
--      (FAILED / EXPIRED) no longer counts. PAN, a GSTIN and FSSAI are never deferred.
--      NEEDS LAWYER / CA SIGN-OFF (docs/seller-verification/COMPLIANCE.md) before production.
-- All three tables are seller-side; the foreign keys stay inside the seller database.
-- ADDITIVE ONLY (the function is replaced with a superset); idempotent.
-- Rollback: scripts/rollback-0113.sql
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "has_udyam" boolean;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "has_fssai" boolean;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "latitude" text;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "longitude" text;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "location_address" text;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "location_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" DROP CONSTRAINT IF EXISTS "shop_registration_drafts_status";--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD CONSTRAINT "shop_registration_drafts_status" CHECK ("status" in ('OPEN', 'SUBMITTED', 'COMPLETED', 'ABANDONED'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_drafts_shop_idx" ON "shop_registration_drafts" ("shop_id") WHERE "shop_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_registration_draft_checks" (
	"draft_id" uuid NOT NULL REFERENCES "shop_registration_drafts"("id") ON DELETE CASCADE,
	"doc_type" text NOT NULL,
	"number_encrypted" text,
	"number_masked" text,
	"number_hash" text,
	"status" text DEFAULT 'NOT_SUBMITTED' NOT NULL,
	"record" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_until" date,
	"provider_id" text,
	"provider_ref" text,
	"error_code" text,
	"idempotency_key" text,
	"consent_given_at" timestamp with time zone,
	"consent_version" text,
	"checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("draft_id", "doc_type"),
	CONSTRAINT "shop_registration_draft_checks_doc_type" CHECK ("doc_type" in ('UDYAM', 'FSSAI', 'SHOP_ACT')),
	CONSTRAINT "shop_registration_draft_checks_status" CHECK ("status" in ('NOT_SUBMITTED', 'PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'MANUAL_REVIEW'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_deferred_document_reviews" (
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"doc_type" text NOT NULL,
	"source" text DEFAULT 'ONBOARDING_WIZARD' NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("shop_id", "doc_type"),
	CONSTRAINT "shop_deferred_document_reviews_doc_type" CHECK ("doc_type" in ('GSTIN', 'SHOP_ACT'))
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shop_document_waivers w WHERE w.shop_id = p_shop)
      OR NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['PAN', 'GSTIN', 'SHOP_ACT']
                  || CASE WHEN shop_sells_food(p_shop, p_type) THEN ARRAY['FSSAI'] ELSE ARRAY[]::text[] END) AS req(doc)
     WHERE NOT EXISTS (
       SELECT 1 FROM seller_verifications v
        WHERE v.shop_id = p_shop AND v.doc_type::text = req.doc
          AND (v.status = 'VERIFIED'
               OR (v.status IN ('PENDING', 'MANUAL_REVIEW')
                   AND EXISTS (SELECT 1 FROM shop_deferred_document_reviews d
                                WHERE d.shop_id = p_shop AND d.doc_type = req.doc)))))
$$;--> statement-breakpoint
-- A deferral added or removed can move a pending shop's stage (same touch as 0051).
DROP TRIGGER IF EXISTS shop_deferred_document_reviews_shop_onboarding ON shop_deferred_document_reviews;--> statement-breakpoint
CREATE TRIGGER shop_deferred_document_reviews_shop_onboarding AFTER INSERT OR DELETE ON shop_deferred_document_reviews
  FOR EACH ROW EXECUTE FUNCTION shop_onboarding_touch_trigger();
