-- Rollback for 0178_dealer_scheme_registration (Dealer platform phase 2; docs/dealer-platform/).
-- Before running: deploy the previous release's code; refund any PAID joining charge first (they are lost here),
-- then delete the 0178 row from drizzle.__drizzle_migrations. The DEALER_JOINING_FEE payment purpose stays allowed.
DROP TABLE IF EXISTS "dealer_joining_payments";
DROP TRIGGER IF EXISTS dealer_scheme_acceptances_append_only ON "dealer_scheme_acceptances";
DROP TABLE IF EXISTS "dealer_scheme_acceptances";
DROP FUNCTION IF EXISTS dealer_scheme_acceptances_append_only();
ALTER TABLE "dealers" DROP COLUMN IF EXISTS "requested_version_id";
