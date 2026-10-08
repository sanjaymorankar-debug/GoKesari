-- Four features (docs/four-features-2026-10): accounts for the end-to-end pass on
-- the TEST site (test.gokesari.com) ONLY. Do not run against production.
--
-- Applied with test-settings.sql by the "Test database" workflow (when either
-- file changes on staging, or Actions → Test database → four-features-settings).
-- Sign-in is the normal email code; these addresses are plus-aliases of the
-- owner's mailbox, so the codes arrive there. Everything else in the pass
-- (customers, shop owners, the rider) signs up through the site itself.
--
-- Remove after testing (Admin → Users → revoke the role, or):
--   UPDATE user_role_grants SET status = 'REVOKED', revoked_at = now()
--    WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sanjaymorankar+gk-%@gmail.com');
--   UPDATE users SET role = 'CUSTOMER' WHERE email LIKE 'sanjaymorankar+gk-%@gmail.com';
BEGIN;

WITH wanted (email, name, role) AS (
  VALUES ('sanjaymorankar+gk-admin@gmail.com', 'E2E Admin (four features)', 'ADMIN'::user_role),
         ('sanjaymorankar+gk-ops@gmail.com', 'E2E Operator (four features)', 'OPERATOR'::user_role)
), created AS (
  INSERT INTO users (email, name, role, email_verified, profile_completed_at)
  SELECT email, name, role, now(), now() FROM wanted
  ON CONFLICT (email) DO NOTHING
  RETURNING id
)
INSERT INTO wallets (user_id) SELECT id FROM created ON CONFLICT DO NOTHING;

INSERT INTO user_role_grants (user_id, role, source)
SELECT u.id, w.role, 'ADMIN'
  FROM users u JOIN (VALUES ('sanjaymorankar+gk-admin@gmail.com', 'ADMIN'::user_role),
                            ('sanjaymorankar+gk-ops@gmail.com', 'OPERATOR'::user_role)) AS w (email, role)
    ON u.email = w.email
ON CONFLICT (user_id, role) DO UPDATE SET status = 'ACTIVE', revoked_at = NULL, revoked_by = NULL;

-- The active role is the granted one (a user who signed in first starts as CUSTOMER).
UPDATE users SET role = 'ADMIN', updated_at = now() WHERE email = 'sanjaymorankar+gk-admin@gmail.com' AND role <> 'ADMIN';
UPDATE users SET role = 'OPERATOR', updated_at = now() WHERE email = 'sanjaymorankar+gk-ops@gmail.com' AND role <> 'OPERATOR';

COMMIT;

SELECT u.email, u.role, u.status, array_agg(g.role::text || ':' || g.status::text ORDER BY g.role) AS grants
  FROM users u LEFT JOIN user_role_grants g ON g.user_id = u.id
 WHERE u.email IN ('sanjaymorankar+gk-admin@gmail.com', 'sanjaymorankar+gk-ops@gmail.com')
 GROUP BY u.email, u.role, u.status ORDER BY u.email;
