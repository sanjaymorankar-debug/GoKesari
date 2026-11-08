-- Owner, 08-Nov-2026: a licence (FSSAI included) never stops a wizard shop going live. It has the
-- grace period of rule shopDocumentFollowUp to upload it and is suspended automatically after that.
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shop_document_waivers w WHERE w.shop_id = p_shop)
      OR EXISTS (SELECT 1 FROM shop_registration_drafts d
                  WHERE d.shop_id = p_shop AND d.status IN ('SUBMITTED', 'COMPLETED') AND d.documents_later IS TRUE)
      OR (EXISTS (SELECT 1 FROM shop_registration_drafts d
                   WHERE d.shop_id = p_shop AND d.status IN ('SUBMITTED', 'COMPLETED'))
          AND EXISTS (SELECT 1 FROM seller_verifications v
                       WHERE v.shop_id = p_shop AND v.status = 'VERIFIED'
                         AND v.doc_type::text = CASE WHEN (SELECT s.gstin FROM shops s WHERE s.id = p_shop) IS NULL
                                                     THEN 'PAN' ELSE 'GSTIN' END))
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
