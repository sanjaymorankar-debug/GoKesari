-- split: seller
-- Shop registration redesign (owner decision 29 Oct 2026, "follow the brief";
-- docs/shop-onboarding-wizard-2026-10/BRIEF_REDESIGN.md). A shop registered through the
-- onboarding wizard is approved automatically once its GSTIN — or, with no GSTIN, its PAN —
-- is verified with the government source and the fee is paid. For such a shop
-- shop_kyc_complete() now asks for that identity document only, plus FSSAI for a food shop;
-- the Shop Act and the other documents are uploaded after go-live and chased by the
-- 1st / 15th follow-up (shop-document-follow-up.ts). Shops registered any other way keep
-- the full list (0051, 0109, 0113), unchanged.
-- A wizard shop is one with a SUBMITTED / COMPLETED row in shop_registration_drafts (same
-- seller database). ADDITIVE ONLY (the function is replaced with a superset); idempotent.
-- Rollback: scripts/rollback-0118.sql
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shop_document_waivers w WHERE w.shop_id = p_shop)
      OR (EXISTS (SELECT 1 FROM shop_registration_drafts d
                   WHERE d.shop_id = p_shop AND d.status IN ('SUBMITTED', 'COMPLETED'))
          AND EXISTS (SELECT 1 FROM seller_verifications v
                       WHERE v.shop_id = p_shop AND v.status = 'VERIFIED'
                         AND v.doc_type::text = CASE WHEN (SELECT s.gstin FROM shops s WHERE s.id = p_shop) IS NULL
                                                     THEN 'PAN' ELSE 'GSTIN' END)
          AND (NOT shop_sells_food(p_shop, p_type)
               OR EXISTS (SELECT 1 FROM seller_verifications v
                           WHERE v.shop_id = p_shop AND v.doc_type::text = 'FSSAI' AND v.status = 'VERIFIED')))
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
-- A draft turning SUBMITTED / COMPLETED can move its shop's onboarding stage.
DROP TRIGGER IF EXISTS shop_registration_drafts_shop_onboarding ON shop_registration_drafts;--> statement-breakpoint
CREATE TRIGGER shop_registration_drafts_shop_onboarding AFTER UPDATE OF status, shop_id ON shop_registration_drafts
  FOR EACH ROW WHEN (NEW.shop_id IS NOT NULL) EXECUTE FUNCTION shop_onboarding_touch_trigger();
