-- Rollback for 0118_registration_identity_approval (shop registration redesign, 29 Oct 2026).
-- Seller database. Run only after the previous release's code is live, then delete the 0118 row
-- from drizzle.__drizzle_migrations. Wizard shops still pending go back to the full document
-- list (PAN, GSTIN or declaration, Shop Act, FSSAI for food); shops already live are not affected.
BEGIN;
DROP TRIGGER IF EXISTS shop_registration_drafts_shop_onboarding ON shop_registration_drafts;
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
$$;
COMMIT;
