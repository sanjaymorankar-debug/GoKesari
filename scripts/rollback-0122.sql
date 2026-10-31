-- Rollback for 0122_rider_bank_payouts (docs/gig-bank-payouts-2026-10).
-- Core database. Before running:
--   1. switch the three flags off (Admin → Feature flags) and deploy the previous release's code;
--   2. check nothing is in flight — this must return 0:
--        SELECT count(*) FROM rider_bank_transfers WHERE status IN ('PENDING', 'PROCESSING') OR (status = 'FAILED' AND needs_review);
--      (settle those first: wait for the bank, or release them from Admin → Rider payouts);
--   3. export rider_bank_transfers and rider_payout_runs if finance wants the history (TDS!).
-- The rider_payouts rows the feature created stay: paid ones are real payments, and released ones
-- are CANCELLED with their earnings already handed back to the weekly batch.
-- Then delete the 0122 row from drizzle.__drizzle_migrations.
BEGIN;
DELETE FROM "feature_flag_changes" WHERE "flag_key" IN ('rider_bank_account_enabled', 'rider_withdrawal_enabled', 'rider_monthly_payout_enabled');
DELETE FROM "feature_flags" WHERE "key" IN ('rider_bank_account_enabled', 'rider_withdrawal_enabled', 'rider_monthly_payout_enabled');
DROP TABLE IF EXISTS "rider_security_grants";
DROP TABLE IF EXISTS "rider_transfer_events";
DROP TABLE IF EXISTS "rider_bank_transfers";
DROP TABLE IF EXISTS "rider_payout_runs";
COMMIT;
