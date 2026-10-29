-- Rollback for 0116_dealer_monthly_payout (docs/dealer-programme, monthly payout).
-- Seller database. Run only after the previous release's code is live, then delete the 0116 row
-- from drizzle.__drizzle_migrations. Payouts already drafted or paid are kept (only their month
-- label goes); admins pay by hand again, as before. Run before rollback-0115.sql.
BEGIN;
DROP TABLE IF EXISTS "dealer_commission_months";
DROP INDEX IF EXISTS "dealer_payout_batches_period_idx";
ALTER TABLE "dealer_payout_batches" DROP COLUMN IF EXISTS "period_month";
-- created_by stays nullable: payouts the monthly job drafted have no creator, and the old code only writes it.
ALTER TABLE "dealer_commission_settings" DROP CONSTRAINT IF EXISTS "dealer_commission_settings_payout_day";
ALTER TABLE "dealer_commission_settings" DROP COLUMN IF EXISTS "payout_day_of_month", DROP COLUMN IF EXISTS "auto_approve_at_month_end";
COMMIT;
