-- Rollback of drizzle/0230_flat_registration_fee_999.sql (owner 28-Nov-2026: flat ₹999 default).
-- Puts back the fee that was in force before 0230 (none on production, ₹100 on staging); then delete the 0230 row from
-- drizzle.__drizzle_migrations. The turnover-slab default (rule registrationFeeByTurnover, off since this release) is
-- code: deploy the previous release's code to switch it back on, or switch it on with the four-eye button.
-- Shops that registered while ₹999 was in force keep that fee (it is snapshotted on the shop); their rows point at
-- the 0230 fee row, so it is only deactivated, never deleted, when a shop references it.
WITH "added" AS (
  SELECT "id", "created_at" FROM "registration_fees" WHERE "note" = 'Owner 28-Nov-2026: flat ₹999 default' ORDER BY "created_at" DESC LIMIT 1
), "previous" AS (
  SELECT f."id" FROM "registration_fees" f, "added" a
  WHERE f."created_at" < a."created_at" AND f."is_active" = false
  ORDER BY f."effective_from" DESC, f."created_at" DESC LIMIT 1
), "restored" AS (
  UPDATE "registration_fees" SET "is_active" = true WHERE "id" IN (SELECT "id" FROM "previous") RETURNING "id"
)
UPDATE "registration_fees" SET "is_active" = false WHERE "id" IN (SELECT "id" FROM "added");
DELETE FROM "registration_fees" f
WHERE f."note" = 'Owner 28-Nov-2026: flat ₹999 default' AND f."is_active" = false
  AND NOT EXISTS (SELECT 1 FROM "shops" s WHERE s."registration_fee_id" = f."id")
  AND NOT EXISTS (SELECT 1 FROM "registration_fee_history" h WHERE h."registration_fee_id" = f."id");
