-- split: seller
-- Shop approval without seller documents: an admin may approve a pending shop whose
-- mandatory seller documents (PAN, GSTIN, Shop Act, FSSAI for food) are not verified,
-- with a written reason. Each override is kept here (append-only), and a shop with one
-- counts as KYC-complete for its onboarding stage, so the lifecycle trigger lets it
-- go live. The fee gate and licence checks (drug licence, FSSAI upload) still apply.
-- waived_by names a user on the customer side, so it has no foreign key (two-database
-- layout). ADDITIVE ONLY; idempotent. Rollback: scripts/rollback-0109.sql
CREATE TABLE IF NOT EXISTS "shop_document_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"missing_doc_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason" text NOT NULL,
	"waived_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_document_waivers_shop_idx" ON "shop_document_waivers" ("shop_id", "created_at");--> statement-breakpoint
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
