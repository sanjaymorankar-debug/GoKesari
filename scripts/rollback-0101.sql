-- Rollback for 0101_dealer_role (docs/dealer-programme, step 1).
-- Not reversible: PostgreSQL cannot drop an enum value. user_role.DEALER is left in place
-- (harmless to the previous code, which never writes it). Before rolling back, move any
-- DEALER user to another role, then delete the 0101 row from drizzle.__drizzle_migrations:
--   UPDATE users SET role = 'CUSTOMER' WHERE role = 'DEALER';
--   UPDATE user_role_grants SET status = 'REVOKED', revoked_at = now() WHERE role = 'DEALER';
BEGIN;
COMMIT;
