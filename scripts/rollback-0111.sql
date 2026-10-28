-- Rollback for 0111_shop_registration_drafts (docs/shop-onboarding-wizard-2026-10, step 1).
-- Seller database. Run only after the previous release's code is live, then delete the 0111 row
-- from drizzle.__drizzle_migrations. Registrations still in progress in the wizard are lost (their
-- owners start again); shops already created from a draft are not affected. Run before
-- rollback-0107.sql.
BEGIN;
DROP TABLE IF EXISTS "shop_registration_drafts";
COMMIT;
