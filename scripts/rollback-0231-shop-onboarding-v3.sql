-- Rollback of drizzle/0231_shop_onboarding_v3.sql (shop onboarding v3 order + licence renewal promises).
-- Deploy the previous release's code first, then run this and delete the 0231 row from drizzle.__drizzle_migrations.
-- Open v3 drafts fall back to the v2 order (their early acceptance is lost; the owner accepts at the agreement step).
ALTER TABLE "registration_licence_entries" DROP COLUMN IF EXISTS "renewal_promised_at";
ALTER TABLE "registration_licence_entries" DROP COLUMN IF EXISTS "expired_on";
ALTER TABLE "shop_registration_drafts" DROP CONSTRAINT IF EXISTS "shop_registration_drafts_flow_order";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_applied_at";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_documents";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_user_agent";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_ip";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_name";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "early_agreement_accepted_at";
ALTER TABLE "shop_registration_drafts" DROP COLUMN IF EXISTS "flow_order";
