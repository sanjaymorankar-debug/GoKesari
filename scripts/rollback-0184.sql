-- Rollback for 0184_dealer_payee_checks_on (dealer payee checks).
-- Before running: deploy the previous release's code, then delete the 0184 row from
-- drizzle.__drizzle_migrations.
-- 0184 only stored dealerPayouts.enforcePayeeChecks = true; no table or column changed.
-- Rolling back stores false again (the same as Admin → Settings → dealerPayouts, audited).
BEGIN;
WITH "before" AS (
  SELECT "key", "value"
  FROM "platform_settings"
  WHERE "key" = 'dealerPayouts'
    AND COALESCE(("value"->>'enforcePayeeChecks')::boolean, false) = true
  FOR UPDATE
), "changed" AS (
  UPDATE "platform_settings" p
  SET "value" = jsonb_set(p."value", '{enforcePayeeChecks}', 'false'::jsonb, true),
      "updated_by" = NULL,
      "updated_at" = now()
  FROM "before" b
  WHERE p."key" = b."key"
  RETURNING b."value" AS "previous_value", p."value" AS "new_value"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "previous_value", "new_value")
SELECT 'setting.changed', 'platform_setting', 'dealerPayouts', "previous_value", "new_value" FROM "changed";
COMMIT;
