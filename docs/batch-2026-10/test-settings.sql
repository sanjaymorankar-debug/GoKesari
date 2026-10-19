-- Build & integrate batch (18 Oct 2026): business-rule values for the TEST
-- site (test.gokesari.com) ONLY. Do not run against production — every
-- provider here is a sandbox or mock, and the tax profile is FAKE.
--
-- Applied by the "Test database" workflow whenever this file changes on staging
-- (after a backup and the migrations — it needs 0079–0084), or by hand:
-- Actions → Test database → Run workflow → batch-2026-10-settings. It can also
-- be run directly:
--   psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/batch-2026-10/test-settings.sql
--
-- Every value stays editable (and audited) in Admin → Business rules; this
-- script only writes the fields it names (jsonb merge over any stored value),
-- so an admin's other choices survive. New values reach the app within 15 s.
-- Undo any rule: Admin → Business rules → <rule> → "Restore default".

INSERT INTO platform_settings (key, value) VALUES
  -- F1.7.3 / F1.8.4: pay an order online through the SANDBOX gateway.
  ('onlinePayments',           '{"enabled": true}'),
  -- F6.2.3: customers may choose a refund to the original method (sandbox gateway).
  ('refundChoice',             '{"originalMethodEnabled": true}'),
  -- F6.1.3: cancelling a packed order costs the shop's fee (defaults: ₹20 flat, limits ₹100 / 20%).
  ('afterPackingCancellation', '{"enabled": true}'),
  -- F3.3.2: broadcast an untaken offer, 2 → 4 → 6 km.
  ('dispatchBroadcast',        '{"enabled": true}'),
  -- F4.1.3: signed single-use pickup QR + packing slip.
  ('pickupQr',                 '{"enabled": true}'),
  -- F4.2.2: in-app navigation on the mock router (no paid maps API on test).
  ('riderNavigation',          '{"enabled": true, "provider": "mock"}'),
  -- F9.1.2: GS1 DataKart MOCK and the Open Food Facts lookup.
  ('pmdSources',               '{"gs1Enabled": true, "openFoodFactsEnabled": true}'),
  -- F9.2.6: invoice QR, email to the customer and a copy to the shop owner.
  ('invoiceDelivery',          '{"enabled": true}'),
  -- F10.2.4: 5-day payouts on the SANDBOX provider (simulated transfers and webhooks).
  ('payouts',                  '{"enabled": true, "provider": "SANDBOX", "sandboxAutoWebhook": true}'),
  -- F10.2.5: GoKesari fee invoices — with a FAKE test tax profile (not GoKesari's real GSTIN).
  ('platformInvoicing',        '{"enabled": true}'),
  ('platformTaxProfile',       '{"legalName": "TEST ONLY — GoKesari staging", "gstin": "27AAAAA0000A1Z5", "pan": "AAAAA0000A", "address": "TEST address, Pune 411001", "stateCode": "MH", "email": "support@gokesari.com"}'),
  -- F13.1.2: push through the MOCK provider (Admin → Test messages shows each push).
  ('push',                     '{"enabled": true, "provider": "mock"}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();

-- What the test site now runs with.
SELECT key, value FROM platform_settings
 WHERE key IN ('onlinePayments', 'refundChoice', 'afterPackingCancellation', 'dispatchBroadcast', 'pickupQr',
               'riderNavigation', 'pmdSources', 'invoiceDelivery', 'payouts', 'platformInvoicing',
               'platformTaxProfile', 'push')
 ORDER BY key;
