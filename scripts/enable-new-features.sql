-- Switches on features F3–F11 (all default OFF in code). Merges into any
-- existing override, so other settings in the same rule are kept.
-- Undo: scripts/disable-new-features.sql (or Admin → Business rules → reset).
-- Run on the TEST database only unless production go-live is intended.
INSERT INTO platform_settings (key, value) VALUES
  ('dispatch',            '{"busyRidersAsFallback": true, "maxActiveDeliveriesPerRider": 2}'),
  ('routing',             '{"enabled": true, "provider": "osrm", "osrmBaseUrl": "https://router.project-osrm.org", "timeoutMs": 3000, "cacheSeconds": 60}'),
  ('deliverySlots',       '{"enabled": true, "defaultExpressPerHour": 20, "defaultStandardPerHour": 30, "defaultScheduledPerDay": 100}'),
  ('parentOrders',        '{"enabled": true}'),
  ('coupons',             '{"enabled": true}'),
  ('shopOffers',          '{"enabled": true}'),
  ('homePriceComparison', '{"enabled": true}'),
  ('imageModeration',     '{"enabled": true}'),
  ('customerReferrals',   '{"enabled": true, "referrerRewardPaise": 5000, "refereeRewardPaise": 5000, "maxRewardsPerReferrer": 20, "applyWithinDays": 30}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();
