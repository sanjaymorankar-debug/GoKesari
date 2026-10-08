-- Reverses drizzle/0064_shop_self_registration.sql (Module 3: shop self-registration).
-- Deploy the previous build first. Back up first.
-- Registrations that were paid are money records: the block below refuses to
-- run while any registration payment succeeded. Export them first and decide.
-- Shops created by self-registration stay (they are ordinary approved shops);
-- their onboarding columns are dropped. Postgres cannot drop an enum value,
-- so CASHFREE stays in shop_payment_method (the previous build never writes it).
-- Afterwards delete the 0064 row from drizzle.__drizzle_migrations.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM registration_payments WHERE status = 'SUCCESS') THEN
    RAISE EXCEPTION 'Paid self-registrations exist: keep them (see the comment at the top).';
  END IF;
END $$;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_shop_registration_id_shop_registrations_id_fk;
ALTER TABLE shops DROP CONSTRAINT IF EXISTS shops_registration_tier_id_registration_fee_tiers_id_fk;
ALTER TABLE shops DROP COLUMN IF EXISTS profile_completed_at;
ALTER TABLE shops DROP COLUMN IF EXISTS auto_approved_at;
ALTER TABLE shops DROP COLUMN IF EXISTS registration_tier_id;
ALTER TABLE shops DROP COLUMN IF EXISTS shop_registration_id;
ALTER TABLE shops DROP COLUMN IF EXISTS onboarding_channel;
ALTER TABLE users DROP COLUMN IF EXISTS email_placeholder;
DROP TABLE IF EXISTS outbound_test_messages;
DROP TABLE IF EXISTS referral_commissions;
DROP TABLE IF EXISTS registration_payments;
DROP TABLE IF EXISTS shop_registrations;
ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS referral_codes_distributor_id_distributors_id_fk;
ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS referral_codes_max_uses_positive;
ALTER TABLE referral_codes DROP COLUMN IF EXISTS max_uses;
ALTER TABLE referral_codes DROP COLUMN IF EXISTS distributor_id;
DROP TABLE IF EXISTS distributors;
DROP TABLE IF EXISTS distributor_types;
DROP TABLE IF EXISTS registration_fee_tiers;
COMMIT;
