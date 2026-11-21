-- Rollback for 0157_franchise_pmr (docs/franchise/README.md).
-- Before running: switch franchise booking off (Admin → Franchise → Settings, bookingOpen false), deploy the previous
-- release's code, then delete the 0157 row from drizzle.__drizzle_migrations.
-- Franchise fees and franchise ledger entries are real money: export them first. The script refuses while any exist.
--   SELECT count(*) FROM payment_intents WHERE purpose = 'FRANCHISE_FEE';
--   SELECT count(*) FROM dealer_commission_ledger WHERE entry_type IN ('ONE_TIME_FRANCHISE', 'RECURRING_BASE', 'RECURRING_BONUS');
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dealer_commission_ledger WHERE entry_type IN ('ONE_TIME_FRANCHISE', 'RECURRING_BASE', 'RECURRING_BONUS')) THEN
    RAISE EXCEPTION 'franchise ledger entries exist: export and remove them by hand first';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_intents WHERE purpose = 'FRANCHISE_FEE') THEN
    RAISE EXCEPTION 'FRANCHISE_FEE payment intents exist: export them first';
  END IF;
END $$;
DROP INDEX IF EXISTS "dealer_commission_ledger_franchise_idx";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "franchise_allocation_id";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "franchise_zone_id";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "config_version";
ALTER TABLE "dealer_commission_ledger" DROP COLUMN IF EXISTS "calc_run_id";
ALTER TABLE "dealer_tier_shop_plans" DROP CONSTRAINT IF EXISTS "dealer_tier_shop_plans_model";
ALTER TABLE "dealer_tier_shop_plans" DROP COLUMN IF EXISTS "model";
ALTER TABLE "dealer_tier_shop_plans" DROP COLUMN IF EXISTS "case_code";
ALTER TABLE "dealer_tier_shop_plans" DROP COLUMN IF EXISTS "franchise_allocation_id";
ALTER TABLE "dealer_tier_shop_plans" DROP COLUMN IF EXISTS "franchise_zone_id";
DROP TABLE IF EXISTS "franchise_calc_runs";
DROP TABLE IF EXISTS "franchise_compliance_violations";
DROP TABLE IF EXISTS "franchise_notification_log";
DROP TABLE IF EXISTS "franchise_monthly_snapshots";
DROP TABLE IF EXISTS "franchise_shop_attribution_history";
DROP TABLE IF EXISTS "franchise_shop_attributions";
DROP TABLE IF EXISTS "franchise_codes";
DROP TABLE IF EXISTS "franchise_campaigns";
DROP TABLE IF EXISTS "franchise_allocation_renewals";
DROP TABLE IF EXISTS "franchise_allocations";
DROP TABLE IF EXISTS "franchise_coupon_redemptions";
DROP TABLE IF EXISTS "franchise_bookings";
DROP TABLE IF EXISTS "franchise_coupon_assignments";
DROP TABLE IF EXISTS "franchise_coupons";
DROP TABLE IF EXISTS "franchise_agreement_acceptances";
DROP TABLE IF EXISTS "franchise_config_versions";
DROP TABLE IF EXISTS "franchise_zone_boundaries";
DROP TABLE IF EXISTS "franchise_zone_status_history";
DROP TABLE IF EXISTS "franchise_zone_fee_versions";
DROP TABLE IF EXISTS "franchise_zone_business";
DROP TABLE IF EXISTS "franchise_shop_area_periods";
DROP TABLE IF EXISTS "franchise_area_zone_history";
DROP TABLE IF EXISTS "franchise_areas";
-- Tables of the first draft of 0157 (91-zone model), in case a database still has them.
DROP TABLE IF EXISTS "franchise_zone_estimates";
DROP TABLE IF EXISTS "franchise_zone_pins";
DROP TABLE IF EXISTS "franchise_zones";
DROP TABLE IF EXISTS "franchise_clusters";
DROP TABLE IF EXISTS "franchise_regions";
DROP TABLE IF EXISTS "franchise_zone_sets";
-- The widened checks keep the extra values (harmless once no rows use them): ledger ONE_TIME_FRANCHISE /
-- RECURRING_BASE / RECURRING_BONUS and payment-intent purpose FRANCHISE_FEE.
COMMIT;
