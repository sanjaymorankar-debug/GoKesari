-- Rollback for 0179_dealer_scheme_commission (Dealer platform phase 3; docs/dealer-platform/).
-- Before running: deploy the previous release's code. Scheme ledger lines must be paid or reversed first (their
-- entry types leave the allowed list). Versions stay published (a published version cannot go back to draft):
-- suspend Business / Growth Partner in Admin → Dealers → Schemes instead. Then delete the 0179 migration row.
DROP INDEX IF EXISTS "dealer_commission_ledger_scheme_idx";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "scheme_component_id";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "scheme_assignment_id";
UPDATE "dealer_schemes" SET "status" = 'SUSPENDED' WHERE "code" IN ('BUSINESS_PARTNER', 'GROWTH_PARTNER');
