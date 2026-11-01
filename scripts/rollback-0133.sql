-- Rollback for 0133_billing_public_api (docs/billing). Core database.
-- Before running: deploy the previous release's code (the public API stops answering). Every client
-- of every shop is removed; tell the shops using it. Then delete the 0133 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "public_api_tokens";
DROP TABLE IF EXISTS "public_api_clients";
COMMIT;
