-- Dealer payouts (23-Nov-2026): every payee — dealer, franchise owner and team member — is paid only
-- with a PAN and a verified bank account (rule dealerPayouts.enforcePayeeChecks; the code default is
-- true now). A site where the rule was saved in Admin → Settings keeps its saved values over the code
-- defaults, so a saved `false` is set to `true` here. A payee who is not ready keeps the amount: it is
-- carried to the next month and the payee is told what to add. Other saved values (minPayoutPaise,
-- reminderEnabled) are not touched. Logged like an admin's change (setting.changed).
-- To switch it off again: Admin → Settings → dealerPayouts (audited); no rollback script is needed.
WITH "before" AS (
  SELECT "key", "value"
  FROM "platform_settings"
  WHERE "key" = 'dealerPayouts'
    AND COALESCE(("value"->>'enforcePayeeChecks')::boolean, false) = false
  FOR UPDATE
), "changed" AS (
  UPDATE "platform_settings" p
  SET "value" = jsonb_set(p."value", '{enforcePayeeChecks}', 'true'::jsonb, true),
      "updated_by" = NULL,
      "updated_at" = now()
  FROM "before" b
  WHERE p."key" = b."key"
  RETURNING b."value" AS "previous_value", p."value" AS "new_value"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "previous_value", "new_value")
SELECT 'setting.changed', 'platform_setting', 'dealerPayouts', "previous_value", "new_value" FROM "changed";
