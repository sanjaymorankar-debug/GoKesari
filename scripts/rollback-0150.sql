-- Rollback for 0150_dealer_main_override_3pct (docs/dealer-programme/TIERED_COMMISSION.md, DT-23).
-- Puts a saved main-dealer share of 3% back to 2%. Before running: deploy the previous release's code
-- (its default is 2%), then delete the 0150 row from drizzle.__drizzle_migrations.
-- Shops activated while it was 3% keep 3%: their plans are frozen and earned commission is never
-- recalculated.
BEGIN;
WITH "before" AS (
  SELECT "key", "value"
  FROM "platform_settings"
  WHERE "key" = 'dealerTieredCommission' AND "value"->>'mainOverrideBp' = '300'
  FOR UPDATE
), "changed" AS (
  UPDATE "platform_settings" p
  SET "value" = jsonb_set(p."value", '{mainOverrideBp}', '200'::jsonb),
      "updated_by" = NULL,
      "updated_at" = now()
  FROM "before" b
  WHERE p."key" = b."key"
  RETURNING b."value" AS "previous_value", p."value" AS "new_value"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "previous_value", "new_value")
SELECT 'setting.changed', 'platform_setting', 'dealerTieredCommission', "previous_value", "new_value" FROM "changed";
COMMIT;
