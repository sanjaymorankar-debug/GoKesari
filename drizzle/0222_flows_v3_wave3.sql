-- Flow spec v3, wave 3 (docs/flows-v3/wave3.md). Flags flow_f4 (shop onboarding), flow_f5 (licence reminders),
-- flow_f6 (shop subscription).
--
-- No table or column changes: wave 3 reuses onboarding v2's tables (registration_licence_entries,
-- shop_legal_documents, shop_membership_periods, inv_settings.banner_upi_qr, shops.whatsapp_number) and the rule
-- shopFlowsV3 (code defaults, admin-editable). Flags: ON on the staging database (gokesari_test), OFF everywhere else.
--
-- Additive and safe to re-run (ON CONFLICT DO NOTHING keeps a flag an admin already switched).
INSERT INTO "feature_flags" ("key", "enabled")
VALUES
  ('flow_f4', current_database() = 'gokesari_test'),
  ('flow_f5', current_database() = 'gokesari_test'),
  ('flow_f6', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
