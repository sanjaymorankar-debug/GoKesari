-- Flat ₹999 registration fee by default (owner, 28-Nov-2026: "fee should be flat 999 as default fee"; "remove
-- turnover slab itself and create a button to switch it on or off by admin / operator with four-eye principle").
-- The turnover slabs (rule registrationFeeByTurnover) are now off by default in the code, so every new shop pays the
-- flat fee schedule (registration_fees). Production had no row there (the fee would have been ₹0) and staging had
-- ₹100: this makes the fee in force ₹999 (99900 paise, before GST) on whichever site it runs.
--
-- Kept as history, like an admin's change (src/server/services/registration-fees.ts setRegistrationFee): the older
-- active rows are deactivated, not deleted, and a new active row is added, effective today (IST). Shops already
-- registered keep the fee snapshotted on them. Safe to re-run: nothing happens when the fee in force is already ₹999.
-- registration_fee_history needs a user (changed_by), so the change is logged in audit_logs (no actor) instead.
-- Rollback: scripts/rollback-0230-flat-registration-fee-999.sql.
WITH "current" AS (
  SELECT "id", "amount_paise"
  FROM "registration_fees"
  WHERE "is_active" = true
  ORDER BY "effective_from" DESC, "created_at" DESC
  LIMIT 1
), "needed" AS (
  SELECT 1 AS "go" WHERE NOT EXISTS (SELECT 1 FROM "current" WHERE "amount_paise" = 99900)
), "retired" AS (
  UPDATE "registration_fees" f
  SET "is_active" = false
  FROM "needed"
  WHERE f."is_active" = true
  RETURNING f."id"
), "created" AS (
  INSERT INTO "registration_fees" ("amount_paise", "currency", "effective_from", "is_active", "note", "created_by")
  SELECT 99900, 'INR', (now() AT TIME ZONE 'Asia/Kolkata')::date, true, 'Owner 28-Nov-2026: flat ₹999 default', NULL
  FROM "needed"
  RETURNING "id", "amount_paise", "effective_from"
)
INSERT INTO "audit_logs" ("action", "entity_type", "entity_id", "previous_value", "new_value")
SELECT 'registration_fee.changed', 'registration_fee', c."id"::text,
       (SELECT jsonb_build_object('amountPaise', "amount_paise") FROM "current"),
       jsonb_build_object('amountPaise', c."amount_paise", 'effectiveFrom', c."effective_from", 'by', 'migration 0230 (owner 28-Nov-2026)',
                          'deactivated', (SELECT count(*) FROM "retired"))
FROM "created" c;
