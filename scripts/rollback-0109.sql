-- Rollback for 0109_shop_document_waivers. Seller database.
-- Run only after the previous release's code is live, then delete the 0109 row from
-- drizzle.__drizzle_migrations. Shops approved without documents stay approved; the
-- record of who waived what is lost (export shop_document_waivers first). Run before
-- rollback-0108.sql.
BEGIN;
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['PAN', 'GSTIN', 'SHOP_ACT']
                  || CASE WHEN shop_sells_food(p_shop, p_type) THEN ARRAY['FSSAI'] ELSE ARRAY[]::text[] END) AS req(doc)
     WHERE NOT EXISTS (
       SELECT 1 FROM seller_verifications v
        WHERE v.shop_id = p_shop AND v.doc_type::text = req.doc AND v.status = 'VERIFIED'))
$$;
DROP TABLE IF EXISTS "shop_document_waivers";
COMMIT;
