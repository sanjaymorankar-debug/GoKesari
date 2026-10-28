-- Rollback for 0113_onboarding_wizard_step2 (docs/shop-onboarding-wizard-2026-10, step 2).
-- Seller database. Run only after the previous release's code is live, then delete the 0113 row
-- from drizzle.__drizzle_migrations. Wizard shops still pending with a Shop Act (or GST
-- declaration) in review go back to KYC_PENDING until an admin verifies it; shops already live
-- are not affected. Drafts past OPEN are kept as SUBMITTED. Run before rollback-0112.sql.
BEGIN;
DROP TRIGGER IF EXISTS shop_deferred_document_reviews_shop_onboarding ON shop_deferred_document_reviews;
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shop_document_waivers w WHERE w.shop_id = p_shop)
      OR NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['PAN', 'GSTIN', 'SHOP_ACT']
                  || CASE WHEN shop_sells_food(p_shop, p_type) THEN ARRAY['FSSAI'] ELSE ARRAY[]::text[] END) AS req(doc)
     WHERE NOT EXISTS (
       SELECT 1 FROM seller_verifications v
        WHERE v.shop_id = p_shop AND v.doc_type::text = req.doc AND v.status = 'VERIFIED'))
$$;
DROP TABLE IF EXISTS "shop_deferred_document_reviews";
DROP TABLE IF EXISTS "shop_registration_draft_checks";
UPDATE "shop_registration_drafts" SET "status" = 'SUBMITTED' WHERE "status" = 'COMPLETED';
ALTER TABLE "shop_registration_drafts" DROP CONSTRAINT IF EXISTS "shop_registration_drafts_status";
ALTER TABLE "shop_registration_drafts" ADD CONSTRAINT "shop_registration_drafts_status" CHECK ("status" in ('OPEN', 'SUBMITTED', 'ABANDONED'));
DROP INDEX IF EXISTS "shop_registration_drafts_shop_idx";
ALTER TABLE "shop_registration_drafts"
  DROP COLUMN IF EXISTS "details",
  DROP COLUMN IF EXISTS "has_udyam",
  DROP COLUMN IF EXISTS "has_fssai",
  DROP COLUMN IF EXISTS "latitude",
  DROP COLUMN IF EXISTS "longitude",
  DROP COLUMN IF EXISTS "location_address",
  DROP COLUMN IF EXISTS "location_confirmed_at",
  DROP COLUMN IF EXISTS "submitted_at",
  DROP COLUMN IF EXISTS "completed_at";
COMMIT;
