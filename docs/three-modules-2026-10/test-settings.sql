-- Three modules (shop photos, accounting/GST, self-registration): business-rule
-- values for the TEST site (test.gokesari.com) ONLY. Do not run against production.
--
-- Applied by the "Test database" workflow whenever this file changes on staging
-- (after a backup and the migrations — it needs 0064), or by hand: Actions →
-- Test database → Run workflow → three-modules-settings
-- (docs/event-driven-2026-10/DB_AUTOMATION.md). Editing it here is how to change
-- the test values on purpose. It can also be run directly:
--   psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/three-modules-2026-10/test-settings.sql
--
-- Check you are on the test database first:
--   select current_database(), inet_server_addr();
--
-- Every value stays editable in the app (audited there; this script is not):
-- Admin → Business rules (selfRegistration, invoicing) and Admin →
-- Self-registration (fee plans). New rule values reach the app within 15 seconds.
-- Undo: Admin → Business rules → selfRegistration → "Restore default" (closes
-- /shop/join); invoicing → "Restore default" (no new invoices).

-- Self-registration open on test: an unpaid registration keeps its place on a
-- referral code for 24 h, at most 3 unpaid registrations per mobile, new shops
-- are Green. Invoicing on, so delivered orders get invoices that the accounting
-- integration (Module 2) pushes and the GSTR-1 export reads.
INSERT INTO platform_settings (key, value) VALUES
  ('selfRegistration', '{"enabled": true, "holdHours": 24, "maxPendingPerMobile": 3, "classification": "GREEN"}'),
  ('invoicing',        '{"enabled": true}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();

-- Fee plans: TEST amounts only. The real amounts are pending from the owner
-- (PLAN.md, pending action P4); set them in Admin → Self-registration.
UPDATE registration_fee_tiers t
   SET amount_paise = v.amount_paise, is_active = true, updated_at = now()
  FROM (VALUES
    ('BASIC',      99900),  -- ₹999
    ('SILVER',    199900),  -- ₹1,999
    ('GOLD',      299900),  -- ₹2,999
    ('PLATINUM',  499900),  -- ₹4,999
    ('INDUSTRY',  999900)   -- ₹9,999
  ) AS v(code, amount_paise)
 WHERE t.code = v.code;

-- What is now in force (defaults fill anything not listed):
SELECT key, value FROM platform_settings WHERE key IN ('selfRegistration', 'invoicing') ORDER BY key;
SELECT code, label, amount_paise / 100 AS rupees, is_active FROM registration_fee_tiers ORDER BY sort_order;
