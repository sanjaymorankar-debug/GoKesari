-- TIERED dealer commission (owner, 20-Nov-2026, DT-23): the main dealer's share on every shop his team
-- signs is 3%, not 2% (rule dealerTieredCommission, mainOverrideBp 200 → 300; the code default is 300 now).
-- A site where the rule was saved in Admin → Settings keeps its saved values over the code defaults, so a
-- saved 2% (the 05-Nov default, set by hand on staging) is moved to 3% here. Any other saved value was
-- chosen on purpose and stays. Only shops activated from now on earn 3%: a shop's plan is frozen at
-- activation and commission already earned is never recalculated. Per-dealer rates
-- (dealers.tier_main_override_bp) are an admin's choice and are not touched.
-- Logged like an admin's change (setting.changed). Rollback: scripts/rollback-0150.sql
WITH "before" AS (
  SELECT "key", "value"
  FROM "platform_settings"
  WHERE "key" = 'dealerTieredCommission'
    AND "value"->>'mainOverrideBp' = '200'
    AND COALESCE(("value"->>'directBp')::int, 2000) + COALESCE(("value"->>'leadOverrideBp')::int, 400) + 300 <= 10000
  FOR UPDATE
), "changed" AS (
  UPDATE "platform_settings" p
  SET "value" = jsonb_set(p."value", '{mainOverrideBp}', '300'::jsonb),
      "updated_by" = NULL,
      "updated_at" = now()
  FROM "before" b
  WHERE p."key" = b."key"
  RETURNING b."value" AS "previous_value", p."value" AS "new_value"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "previous_value", "new_value")
SELECT 'setting.changed', 'platform_setting', 'dealerTieredCommission', "previous_value", "new_value" FROM "changed";
