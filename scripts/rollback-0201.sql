-- Rollback for drizzle/0201_seller_goods_undertaking.sql (docs/seller-undertaking-2026-11).
-- The consent_type values SELLER_GOODS_UNDERTAKING / SELLER_TERMS cannot be dropped; once no row uses them they are inert.
-- Deleting the seller consent rows removes the evidence of acceptance: only do it if the owner agrees.
BEGIN;
DELETE FROM "feature_flags" WHERE "key" = 'seller_undertaking_gate_enabled';
DROP INDEX IF EXISTS "user_consents_user_type_created_idx";
ALTER TABLE "user_consents" DROP COLUMN IF EXISTS "user_agent";
ALTER TABLE "user_consents" DROP COLUMN IF EXISTS "shop_id";
COMMIT;
