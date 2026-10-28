-- Rollback for 0104_dealers (docs/dealer-programme, step 2). Seller database.
-- Run only after the previous release's code is live, then delete the 0104 row from
-- drizzle.__drizzle_migrations. Dealers, their documents, employees, territories and the
-- dealer-code links are lost — back up first. referral_codes, distributors and every
-- referral_redemptions / referral_commissions row are untouched (the migration never changed
-- them), so legacy codes keep working. Codes generated for dealers (GKS-MH-…, GKS-FE-…) stay in
-- referral_codes; set them INACTIVE first if they must stop working:
--   UPDATE referral_codes SET status = 'INACTIVE' WHERE code LIKE 'GKS-MH-%' OR code LIKE 'GKS-FE-%';
-- Users who hold the DEALER role keep it until revoked (see rollback-0101.sql).
BEGIN;
DROP TABLE IF EXISTS "dealer_codes";
DROP TABLE IF EXISTS "dealer_salespeople";
DROP TABLE IF EXISTS "dealer_territories";
DROP TABLE IF EXISTS "dealer_documents";
DROP TABLE IF EXISTS "dealer_document_requirements";
DROP TABLE IF EXISTS "dealers";
COMMIT;
