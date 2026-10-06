-- Switches features F3–F11 back off (the original behaviour). F1 status
-- enforcement is controlled separately by the 'statusModels' rule.
INSERT INTO platform_settings (key, value) VALUES
  ('dispatch',            '{"busyRidersAsFallback": false}'),
  ('routing',             '{"enabled": false}'),
  ('deliverySlots',       '{"enabled": false}'),
  ('parentOrders',        '{"enabled": false}'),
  ('coupons',             '{"enabled": false}'),
  ('shopOffers',          '{"enabled": false}'),
  ('homePriceComparison', '{"enabled": false}'),
  ('imageModeration',     '{"enabled": false}'),
  ('customerReferrals',   '{"enabled": false}')
ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now();
