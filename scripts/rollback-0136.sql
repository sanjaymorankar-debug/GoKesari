-- Rollback for 0136_dealer_tiered_commission (docs/dealer-programme/TIERED_COMMISSION.md).
-- Seller database (on the split layout; the one database otherwise). Before running:
--   1. switch rule dealerTieredCommission off (Admin → Settings) and deploy the previous release's code;
--   2. check no TIERED money is in flight — these must return 0:
--        SELECT count(*) FROM dealer_commission_ledger WHERE entry_type <> 'BASE' AND status IN ('APPROVED', 'PAID');
--        SELECT count(*) FROM dealer_payout_batches WHERE member_id IS NOT NULL OR tds_paise > 0;
--      (pay or cancel those payouts first; a PAID TIERED entry is a real payment — export it);
--   3. export dealer_commission_ledger, dealer_tier_shop_plans and dealer_team_developments if
--      finance wants the history.
-- Every TIERED ledger entry is deleted (the old unique key cannot hold several accruals per shop),
-- team members lose their levels and payee details, and dealers go back to the standard model.
-- Then delete the 0136 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TABLE IF EXISTS "dealer_team_requests";
DROP TABLE IF EXISTS "dealer_team_developments";
DROP TABLE IF EXISTS "dealer_tier_shop_plans";
DELETE FROM "dealer_commission_ledger" WHERE "reverses_id" IN (SELECT "id" FROM "dealer_commission_ledger" WHERE "entry_type" <> 'BASE');
DELETE FROM "dealer_commission_ledger" WHERE "entry_type" <> 'BASE';
DROP INDEX IF EXISTS "dealer_commission_ledger_payee_idx";
DROP INDEX IF EXISTS "dealer_commission_ledger_accrual_key_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_commission_ledger_accrual_unique" ON "dealer_commission_ledger" ("shop_id", "milestone", "above_cap") WHERE "kind" = 'ACCRUAL';
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_level";
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_shop";
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_entry_type";
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_milestone";
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_milestone" CHECK ("milestone" in ('REGISTERED', 'VERIFIED_CATALOGUE', 'ACTIVATED'));
ALTER TABLE "dealer_commission_ledger" ALTER COLUMN "shop_id" SET NOT NULL;
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "accrual_key";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "level";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "payee_member_id";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "entry_type";
ALTER TABLE "dealer_payout_batches" DROP CONSTRAINT IF EXISTS "dealer_payout_batches_tds";
DROP INDEX IF EXISTS "dealer_payout_batches_member_idx";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "tds_rate_bp";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "tds_paise";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "member_id";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_parent_fk";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_recruiter_fk";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_role";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_depth";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_parent_shape";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_lead_depth";
ALTER TABLE "dealer_salespeople" DROP CONSTRAINT IF EXISTS "dealer_salespeople_bank_status";
DROP INDEX IF EXISTS "dealer_salespeople_level_key";
DROP INDEX IF EXISTS "dealer_salespeople_dealer_key";
DROP INDEX IF EXISTS "dealer_salespeople_parent_idx";
DROP INDEX IF EXISTS "dealer_salespeople_user_idx";
ALTER TABLE "dealer_salespeople"
  DROP COLUMN IF EXISTS "team_role", DROP COLUMN IF EXISTS "depth", DROP COLUMN IF EXISTS "parent_id",
  DROP COLUMN IF EXISTS "parent_depth", DROP COLUMN IF EXISTS "parent_role", DROP COLUMN IF EXISTS "recruited_by_id",
  DROP COLUMN IF EXISTS "promoted_at", DROP COLUMN IF EXISTS "pan_enc", DROP COLUMN IF EXISTS "pan_hash",
  DROP COLUMN IF EXISTS "pan_last4", DROP COLUMN IF EXISTS "bank_holder_name", DROP COLUMN IF EXISTS "bank_account_enc",
  DROP COLUMN IF EXISTS "bank_account_last4", DROP COLUMN IF EXISTS "bank_ifsc", DROP COLUMN IF EXISTS "bank_status",
  DROP COLUMN IF EXISTS "bank_status_reason", DROP COLUMN IF EXISTS "bank_verified_at", DROP COLUMN IF EXISTS "bank_check_ref",
  DROP COLUMN IF EXISTS "agreement_version", DROP COLUMN IF EXISTS "agreement_accepted_at";
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_commission_model";
ALTER TABLE "dealers" DROP CONSTRAINT IF EXISTS "dealers_tier_percents";
ALTER TABLE "dealers"
  DROP COLUMN IF EXISTS "commission_model", DROP COLUMN IF EXISTS "tier_direct_bp", DROP COLUMN IF EXISTS "tier_lead_override_bp",
  DROP COLUMN IF EXISTS "tier_main_override_bp", DROP COLUMN IF EXISTS "tier_agreement_version", DROP COLUMN IF EXISTS "tier_agreement_accepted_at";
COMMIT;
-- Split layout: the next migrate run re-imports the core's foreign tables (reconcile in scripts/split-migrate.mjs).
