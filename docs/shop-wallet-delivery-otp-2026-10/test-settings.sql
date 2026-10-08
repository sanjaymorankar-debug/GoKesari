-- Shop prepaid wallet + delivery code — business-rule values for the TEST site
-- (test.gokesari.com) ONLY. Do not run against production.
--
-- NOT applied automatically (unlike docs/event-driven-2026-10/test-settings.sql):
-- run it by hand once migration 0059 is on the test database, when you are
-- ready to switch the shop wallet on:
--   psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/shop-wallet-delivery-otp-2026-10/test-settings.sql
--
-- Check you are on the test database first:
--   select current_database(), inet_server_addr();
--
-- The amounts below are TEST values chosen to make each case easy to see, not
-- a business decision (see README.md "Decisions needed"). Every value stays
-- editable in Admin → Business rules (that path is audited; this script is
-- not). New values reach the app within 15 seconds (rule cache).
-- Undo: Admin → Business rules → shopWallet → "Restore default" (switches it off).
INSERT INTO platform_settings (key, value) VALUES
  -- Wallet on; ₹20 delivery charge per rider-delivered order; a shop needs
  -- ₹100 to accept new orders and is reminded below ₹200; recharges ₹100–₹50,000.
  ('shopWallet',  '{"enabled": true, "deliveryChargePaise": 2000, "minBalancePaise": 10000, "lowBalanceThresholdPaise": 20000, "topupMinPaise": 10000, "topupMaxPaise": 5000000}'),
  -- 5 wrong delivery codes lock the drop; a new code at most every 60 s, 3 per delivery.
  ('deliveryOtp', '{"maxAttempts": 5, "resendCooldownSeconds": 60, "maxResends": 3}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();

-- Commission: 10% platform default, ONLY if no commission rate is set yet
-- (rates are managed in Admin → Finance → Commission; this never overrides one).
INSERT INTO commission_rates (scope, rate_bp, note)
SELECT 'DEFAULT', 1000, 'Test default (docs/shop-wallet-delivery-otp-2026-10/test-settings.sql)'
WHERE NOT EXISTS (SELECT 1 FROM commission_rates WHERE is_active);

-- What is now in force (defaults fill anything not listed):
SELECT key, value FROM platform_settings WHERE key IN ('shopWallet', 'deliveryOtp') ORDER BY key;
SELECT scope, shop_type, shop_id, rate_bp FROM commission_rates WHERE is_active ORDER BY scope;
