-- Payout deductions (docs/tax-register/PAYOUT_DEDUCTIONS.md). Flag payout_deductions (OFF):
--  * weekly rider payouts deduct TDS s.194C (rule riderPayouts) and record it;
--  * referral commissions deduct TDS s.194H (statutory row IT_TDS_194H) when paid;
--  * the payout cycle deducts TDS s.194-O (and TCS when the CA's row says services are covered)
--    on service earnings (appointments, rentals, prescriptions);
--  * the weekly shop settlement stays for shops only while the flag is off (with it on, shops are
--    paid through the payout cycle, which deducts TCS / TDS).
-- New statutory rows IT_TDS_194H and IT_TDS_194J are added DISABLED and not confirmed by the CA:
-- the CA confirms or changes them through the tax register before anything is deducted.
-- Additive only. Rollback: scripts/rollback-0186.sql
ALTER TABLE "rider_payouts" ADD COLUMN IF NOT EXISTS "tds_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "rider_payouts" ADD COLUMN IF NOT EXISTS "tds_rate_bp" integer;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD COLUMN IF NOT EXISTS "tds_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD COLUMN IF NOT EXISTS "tds_rate_bp" integer;
--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD COLUMN IF NOT EXISTS "net_paise" bigint;
--> statement-breakpoint
INSERT INTO "statutory_rates" ("key", "label", "enabled", "rate_bp", "params", "effective_from", "effective_to", "legal_reference", "source_url", "note") VALUES
('IT_TDS_194H', 'Income-tax TDS on commission or brokerage (Sec 194H / s.393 ITA 2025)', false, 200, '{"noPanRateBp": 2000, "annualThresholdPaise": 2000000, "singlePaymentThresholdPaise": 2000000, "sectionLabel": "Sec 194H / s.393 ITA 2025"}'::jsonb, '2026-04-01', NULL, 'Sec 194H (2% from 1 Oct 2024); threshold Rs 20,000 a year from 1 Apr 2025; s.206AA 20% without PAN', NULL, 'Disabled until the CA confirms rate, threshold and the s.393 mapping (referral commissions).'),
('IT_TDS_194J', 'Income-tax TDS on professional / technical fees (Sec 194J / s.393 ITA 2025)', false, 1000, '{"noPanRateBp": 2000, "annualThresholdPaise": 5000000, "singlePaymentThresholdPaise": 5000000, "sectionLabel": "Sec 194J / s.393 ITA 2025"}'::jsonb, '2026-04-01', NULL, 'Sec 194J (10% professional fees, 2% technical services); threshold Rs 50,000 a year from 1 Apr 2025; s.206AA 20% without PAN', NULL, 'Disabled; not used by any payout yet. For the CA to confirm.')
ON CONFLICT ("key", "effective_from") DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('payout_deductions', false) ON CONFLICT ("key") DO NOTHING;
