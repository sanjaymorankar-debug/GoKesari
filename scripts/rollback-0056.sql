-- Reverses drizzle/0056_shop_customer_contact.sql (C1). Set rule shopContact
-- back to REGISTERED_PHONE (or restore its default) first, and deploy the
-- previous build. Back up first: this drops the numbers shopkeepers entered.
-- Afterwards delete the 0056 row from drizzle.__drizzle_migrations.
BEGIN;
ALTER TABLE shops DROP COLUMN IF EXISTS contact_phone, DROP COLUMN IF EXISTS whatsapp_number;
COMMIT;
