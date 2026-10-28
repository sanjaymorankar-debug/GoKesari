-- Rollback for 0108_support_services (docs/dealer-programme, step 7). Core database.
-- Run only after the previous release's code is live, then delete the 0108 row from
-- drizzle.__drizzle_migrations. Support-service requests (with their receipts and files),
-- charges and settings are lost — export them first (they are payment records). Their
-- help-desk tickets, wallet entries and payment intents stay. Payment intents of purpose
-- SUPPORT_SERVICE must be gone (or their purpose changed) before the old check comes back;
-- this script stops otherwise. Run before rollback-0107.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payment_intents" WHERE "purpose" = 'SUPPORT_SERVICE') THEN
    RAISE EXCEPTION 'payment_intents with purpose SUPPORT_SERVICE exist; resolve them first';
  END IF;
END $$;
BEGIN;
DROP TABLE IF EXISTS "support_service_files";
DROP TABLE IF EXISTS "support_service_requests";
DROP TABLE IF EXISTS "support_service_settings";
DROP TABLE IF EXISTS "support_service_charges";
DROP TABLE IF EXISTS "support_service_types";
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE'));
COMMIT;
