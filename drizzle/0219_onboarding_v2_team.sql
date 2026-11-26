-- Onboarding v2, Flow 4 — My team (docs/onboarding-v2-2026-11). Flag `onboarding_v2`.
--
-- One person holds at most one ACTIVE place in any dealer team: a partial unique index on
-- dealer_salespeople(user_id) for ACTIVE rows with a linked account. The v2 accept also takes a transaction
-- advisory lock on the account, so new accepts are safe even without the index.
--
-- If existing data already has an account ACTIVE in two teams (possible on production through the older
-- admin "link account" path), the index is NOT created and a NOTICE names the count — the migration does not
-- fail. Clean the duplicates up (Admin → Dealers), then re-run this file by hand to add the index.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0219-onboarding-v2-team.sql.
DO $$
DECLARE
  dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT user_id FROM dealer_salespeople
    WHERE status = 'ACTIVE' AND user_id IS NOT NULL
    GROUP BY user_id HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE NOTICE '0219: % account(s) are ACTIVE in more than one dealer team; dealer_salespeople_active_user_unique not created', dupes;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS dealer_salespeople_active_user_unique
      ON dealer_salespeople (user_id)
      WHERE status = 'ACTIVE' AND user_id IS NOT NULL;
  END IF;
END $$;
