-- Rollback for 0177_dealer_schemes (Dealership & Franchise Platform phase 1; docs/dealer-platform/).
-- Before running: deploy the previous release's code, then delete the 0177 row from drizzle.__drizzle_migrations.
-- Scheme history is lost; commission is unaffected (phase 1 does not calculate from schemes).
DROP TRIGGER IF EXISTS franchise_allocations_scheme_sync ON "franchise_allocations";
DROP TRIGGER IF EXISTS dealers_default_scheme ON "dealers";
DROP FUNCTION IF EXISTS franchise_allocations_scheme_sync();
DROP FUNCTION IF EXISTS dealers_default_scheme();
DROP FUNCTION IF EXISTS dealer_scheme_assign(uuid, text, text, text);
DROP TABLE IF EXISTS "dealer_scheme_assignments";
DROP TABLE IF EXISTS "dealer_scheme_versions";
DROP TABLE IF EXISTS "dealer_schemes";
DROP FUNCTION IF EXISTS dealer_scheme_assignments_guard();
DROP FUNCTION IF EXISTS dealer_scheme_versions_guard();
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "logo_url";
