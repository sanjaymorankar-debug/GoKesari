-- Rollback for 0140_ca_role (gap report D4). PostgreSQL cannot drop an enum value; the CA value
-- stays in user_role and is simply unused once the previous release's code is deployed. Take the
-- role away from every user first:
--   UPDATE users SET role = 'CUSTOMER' WHERE role = 'CA';
--   DELETE FROM user_role_grants WHERE role = 'CA';
-- Then delete the 0140 row from drizzle.__drizzle_migrations.
SELECT 1;
