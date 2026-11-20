-- Rollback for 0152_consult_bookings (docs/consult-booking-2026-11).
-- Before running: switch rule consultBooking off, deploy the previous release's code, then delete the
-- 0152 row from drizzle.__drizzle_migrations.
-- Checks first: bookings paid online and their payout lines are real money. Export them, and refuse to
-- drop while any exists:
--   SELECT count(*) FROM consult_bookings WHERE paid_online_paise > 0 OR paid_offline_paise > 0;
--   SELECT count(*) FROM payment_intents WHERE purpose = 'CONSULT_BOOKING';
--   SELECT count(*) FROM financial_adjustments WHERE idempotency_key LIKE 'consult:%';
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents WHERE purpose = 'CONSULT_BOOKING') THEN
    RAISE EXCEPTION 'CONSULT_BOOKING payment intents exist: export them (and their bookings) first';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_adjustments WHERE idempotency_key LIKE 'consult:%') THEN
    RAISE EXCEPTION 'Consultant settlement lines exist: export them first';
  END IF;
END $$;
DELETE FROM scheduled_notices WHERE kind = 'CONSULT_REMINDER';
DROP TABLE IF EXISTS "consult_receipt_counters";
DROP TABLE IF EXISTS "consult_access_logs";
DROP TABLE IF EXISTS "consult_booking_files";
DROP TABLE IF EXISTS "consult_booking_events";
DROP TABLE IF EXISTS "consult_booking_members";
DROP TABLE IF EXISTS "consult_bookings";
DROP SEQUENCE IF EXISTS "consult_booking_number_seq";
DROP TABLE IF EXISTS "consult_time_off";
DROP TABLE IF EXISTS "consult_weekly_hours";
DROP TABLE IF EXISTS "consult_services";
DROP TABLE IF EXISTS "consult_member_documents";
DROP TABLE IF EXISTS "consult_member_categories";
DROP TABLE IF EXISTS "consult_members";
DROP TABLE IF EXISTS "consult_profiles";
DROP TABLE IF EXISTS "consult_policy_templates";
DROP TABLE IF EXISTS "consult_categories";
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE', 'SUPPORT_SERVICE', 'TERRITORY_FEE'));
-- btree_gist is left installed (harmless; other objects may use it).
COMMIT;
