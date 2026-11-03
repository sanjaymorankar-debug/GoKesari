-- Rollback for 0138_dealer_team_history (gap report A8 / A9). Seller database (the one database
-- otherwise). Before running: deploy the previous release's code. The history is lost — export
-- dealer_team_mapping_history and dealer_agreement_acceptances first if anyone needs them.
-- Then delete the 0138 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "dealer_agreement_acceptances";
DROP TABLE IF EXISTS "dealer_team_mapping_history";
COMMIT;
-- Split layout: the next migrate run re-imports the core's foreign tables (reconcile in scripts/split-migrate.mjs).
