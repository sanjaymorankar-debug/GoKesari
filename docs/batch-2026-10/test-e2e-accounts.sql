-- Build & integrate batch (18 Oct 2026): the Operator-Limited account for the
-- end-to-end pass on the TEST site (test.gokesari.com) ONLY. Do not run against
-- production.
--
-- Applied with test-settings.sql by the "Test database" workflow (needs 0082,
-- which adds the OPERATOR_LIMITED role). Sign-in is the normal email code; the
-- address is a plus-alias of the owner's mailbox, like the other E2E accounts
-- (docs/four-features-2026-10/test-e2e-accounts.sql).
--
-- Remove after testing:
--   UPDATE user_role_grants SET status = 'REVOKED', revoked_at = now()
--    WHERE user_id = (SELECT id FROM users WHERE email = 'sanjaymorankar+gk-oplim@gmail.com');
--   UPDATE users SET role = 'CUSTOMER' WHERE email = 'sanjaymorankar+gk-oplim@gmail.com';
BEGIN;

WITH created AS (
  INSERT INTO users (email, name, role, email_verified, profile_completed_at)
  VALUES ('sanjaymorankar+gk-oplim@gmail.com', 'E2E Operator Limited (batch 2026-10)', 'OPERATOR_LIMITED'::user_role, now(), now())
  ON CONFLICT (email) DO NOTHING
  RETURNING id
)
INSERT INTO wallets (user_id) SELECT id FROM created ON CONFLICT DO NOTHING;

INSERT INTO user_role_grants (user_id, role, source)
SELECT id, 'OPERATOR_LIMITED'::user_role, 'ADMIN' FROM users WHERE email = 'sanjaymorankar+gk-oplim@gmail.com'
ON CONFLICT (user_id, role) DO UPDATE SET status = 'ACTIVE', revoked_at = NULL, revoked_by = NULL;

-- The active role is the granted one (a user who signed in first starts as CUSTOMER).
UPDATE users SET role = 'OPERATOR_LIMITED', updated_at = now()
 WHERE email = 'sanjaymorankar+gk-oplim@gmail.com' AND role <> 'OPERATOR_LIMITED';

COMMIT;

SELECT u.email, u.role, u.status, array_agg(g.role::text || ':' || g.status::text ORDER BY g.role) AS grants
  FROM users u LEFT JOIN user_role_grants g ON g.user_id = u.id
 WHERE u.email = 'sanjaymorankar+gk-oplim@gmail.com'
 GROUP BY u.email, u.role, u.status;
