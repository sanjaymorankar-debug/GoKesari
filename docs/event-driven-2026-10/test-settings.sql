-- Event layer (docs/event-driven-2026-10) — business-rule values for the
-- TEST site (test.gokesari.com) ONLY. Do not run against production.
--
-- Applied automatically by the "Test database" workflow whenever this file
-- changes on staging (DB_AUTOMATION.md); editing it here is how to change the
-- test values on purpose.
--
-- Check you are on the test database first:
--   select current_database(), inet_server_addr();
--
-- Merges into any existing override, so other settings in each rule are kept.
-- Every value stays editable in Admin → Business rules (that path is audited;
-- this script is not). New values reach the app within 15 seconds (rule cache).
-- Undo: Admin → Business rules → "Restore default" per rule, or ROLLBACK.md §2.
INSERT INTO platform_settings (key, value) VALUES
  -- X = 30 minutes for the shop to accept; then cancel with a full refund
  -- (set "onTimeout": "ESCALATE" to alert support instead and keep the order).
  ('shopAcceptance',     '{"enabled": true, "acceptMinutes": 30, "reminderAtFraction": 0.5, "onTimeout": "CANCEL"}'),
  -- Y = 30 minutes with no rider accepted before support is alerted.
  ('dispatch',           '{"alertSupportAfterMinutes": 30}'),
  -- N = 4 send attempts, then the message is dead and support is alerted in the app.
  ('notifications',      '{"maxAttempts": 4, "alertSupportOnDead": true}'),
  -- Dispute SLA = 24 hours without a reply from the shop or support → escalated to an administrator.
  ('disputes',           '{"responseSlaHours": 24}'),
  -- Approve a shop as soon as its last mandatory document is verified and its fee is settled;
  -- remind support daily of documents waiting in manual review for more than 24 hours.
  ('sellerVerification', '{"autoApproveShop": true, "autoApproveClassification": "GREEN", "manualReviewReminderHours": 24}'),
  -- Live tracking: rider location every 5 s once the drop starts; the open map refreshes every 5 s.
  ('tracking',           '{"riderPingSeconds": 5, "buyerPollSeconds": 5}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();

-- What is now in force (defaults fill anything not listed):
SELECT key, value FROM platform_settings
WHERE key IN ('shopAcceptance', 'dispatch', 'notifications', 'disputes', 'sellerVerification', 'tracking')
ORDER BY key;
