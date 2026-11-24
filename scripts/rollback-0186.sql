-- Rollback for 0186_payout_deductions (docs/tax-register/PAYOUT_DEDUCTIONS.md).
-- Before running: deploy the previous release's code, then delete the 0186 row from
-- drizzle.__drizzle_migrations. TDS already deducted stays recorded in the audit log only.
BEGIN;
ALTER TABLE "rider_payouts" DROP COLUMN IF EXISTS "tds_paise";
ALTER TABLE "rider_payouts" DROP COLUMN IF EXISTS "tds_rate_bp";
ALTER TABLE "referral_commissions" DROP COLUMN IF EXISTS "tds_paise";
ALTER TABLE "referral_commissions" DROP COLUMN IF EXISTS "tds_rate_bp";
ALTER TABLE "referral_commissions" DROP COLUMN IF EXISTS "net_paise";
DELETE FROM "statutory_rates" WHERE "key" IN ('IT_TDS_194H', 'IT_TDS_194J') AND "effective_from" = '2026-04-01' AND NOT "confirmed_by_ca";
DELETE FROM "feature_flags" WHERE "key" = 'payout_deductions';
COMMIT;
