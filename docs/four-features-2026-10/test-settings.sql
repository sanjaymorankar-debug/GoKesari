-- Four features (docs/four-features-2026-10) — business-rule values for the TEST
-- site (test.gokesari.com) ONLY. Do not run against production.
--
-- Applied by the "Test database" workflow whenever this file changes on staging
-- (after a backup and the migrations), or by hand: Actions → Test database →
-- Run workflow → four-features-settings. Every value stays editable in
-- Admin → Business rules (audited; this script is not). New values reach the app
-- within 15 seconds (rule cache). Undo one: Business rules → <rule> → "Restore default".
--
-- Check you are on the test database first:
--   select current_database(), inet_server_addr();
INSERT INTO platform_settings (key, value) VALUES
  -- 1. Fulfilment options: shops choose pickup / own delivery / GoKesari partner
  --    and a 1-hour slot (07:00–22:00 IST, up to 7 days ahead) when marking ready.
  ('fulfilmentOptions', '{"enabled": true}'),
  -- 2. Mandatory legal documents: FSSAI / drug licence / medical registration,
  --    15-day grace for live shops, reminders 30 days before expiry.
  ('legalDocuments', '{"enabled": true, "graceDays": 15, "expiryReminderDays": 30}'),
  -- 3. Bank accounts: prompts on; a shop payout waits for a verified account.
  ('bankAccounts', '{"enabled": true, "requireVerifiedForShopPayouts": true}'),
  -- 4. Referral code required on self-service shop registration; requests are
  --    emailed to referrals@gokesari.com. On test only, a copy also goes to a
  --    plus-alias of the owner's mailbox so the end-to-end pass can read the
  --    email (remove it in Business rules → shopReferral when testing is done).
  ('shopReferral', '{"required": true, "notifyEmails": ["referrals@gokesari.com", "sanjaymorankar+gk-referrals@gmail.com"]}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();

-- What is now in force (code defaults fill anything not listed):
SELECT key, value FROM platform_settings
 WHERE key IN ('fulfilmentOptions', 'legalDocuments', 'bankAccounts', 'shopReferral') ORDER BY key;
