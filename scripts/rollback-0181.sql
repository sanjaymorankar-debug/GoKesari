-- Rollback for 0181_dealer_platform_roles (Dealer platform phase 6; docs/dealer-platform/).
-- Before running: move anyone holding the six new roles back to their previous role, deploy the previous release's
-- code, then delete the 0181 row. The enum values stay (PostgreSQL cannot drop them); unused, they are inert.
DROP TABLE IF EXISTS "staff_region_scopes";
DELETE FROM "feature_flags" WHERE "key" = 'dealer_platform_four_eye';
