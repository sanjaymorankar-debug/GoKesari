-- Rollback for 0166_dealer_online_verification (owner 22-Nov-2026; docs/dealer-programme/ONLINE_VERIFICATION.md).
-- Before running: deploy the previous release's code (documents checked online then need an upload again),
-- then delete the 0166 row from drizzle.__drizzle_migrations.
DROP TABLE IF EXISTS "dealer_verifications";
