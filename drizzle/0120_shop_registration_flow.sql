-- split: seller
-- Shop registration flow (owner brief, 30 Oct 2026; docs/shop-onboarding-wizard-2026-10/FLOW_2026-10-30.md).
-- The wizard now opens with the referral code, the shop's email (the account's, or another one
-- confirmed with an emailed code) and "Do you have your documents handy?". An owner who answers
-- "upload later" registers with the shop name, address and map pin alone, pays, and the shop goes
-- live on payment (FSSAI still needed for a food shop); payouts are held until the GSTIN or PAN is
-- verified, and the 1st / 15th follow-up chases the documents. ADDITIVE ONLY; idempotent.
-- Rollback: scripts/rollback-0120.sql
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "referral_code" text;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "referral_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "shop_email" text;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "shop_email_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_registration_drafts" ADD COLUMN IF NOT EXISTS "documents_later" boolean;--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM shop_document_waivers w WHERE w.shop_id = p_shop)
      -- 0120: a wizard shop registered with "upload documents later": FSSAI for a food shop only.
      OR (EXISTS (SELECT 1 FROM shop_registration_drafts d
                   WHERE d.shop_id = p_shop AND d.status IN ('SUBMITTED', 'COMPLETED') AND d.documents_later IS TRUE)
          AND (NOT shop_sells_food(p_shop, p_type)
               OR EXISTS (SELECT 1 FROM seller_verifications v
                           WHERE v.shop_id = p_shop AND v.doc_type::text = 'FSSAI' AND v.status = 'VERIFIED')))
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
$$;
