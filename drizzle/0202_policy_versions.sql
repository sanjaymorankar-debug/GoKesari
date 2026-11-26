-- Policy re-consent (open-features CONSENT, 24-Nov-2026; docs/policy-reconsent-2026-11/README.md).
--
-- * policy_versions: one row per published version of a policy document (terms, privacy-policy,
--   seller-terms). The newest row with requires_acceptance = true is the version signed-in users must
--   have accepted; a minor edit is published with requires_acceptance = false and asks nobody again.
--   Seeded with today's version (2026-10-24) as a baseline that asks nobody.
-- * policy_acceptances: append-only record of who accepted which version, when, and through which
--   channel (WEB, APP, SHOP_PORTAL, RIDER_PORTAL, DEALER_PORTAL, SIGNUP, SHOP_REGISTRATION, API).
--   No foreign key to users (single-database code, but kept like user_consents' dependants: deleted
--   explicitly by the service that deletes a user).
-- * feature flag policy_reconsent_enabled (OFF): with it off nobody is asked and the admin page only
--   reports.
--
-- Additive and safe to re-run. Rollback: DROP TABLE policy_acceptances, policy_versions;
-- DELETE FROM feature_flags WHERE key = 'policy_reconsent_enabled'.
CREATE TABLE IF NOT EXISTS "policy_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "doc" text NOT NULL,
  "version" text NOT NULL,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "requires_acceptance" boolean NOT NULL DEFAULT true,
  "published_at" timestamp with time zone NOT NULL DEFAULT now(),
  "published_by" uuid,
  "reason" text,
  CONSTRAINT "policy_versions_doc_check" CHECK ("doc" IN ('terms', 'privacy-policy', 'seller-terms'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_versions_doc_version_uq" ON "policy_versions" ("doc", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_versions_doc_published_idx" ON "policy_versions" ("doc", "published_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "doc" text NOT NULL,
  "version" text NOT NULL,
  "channel" text NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "accepted_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_acceptances_user_doc_idx" ON "policy_acceptances" ("user_id", "doc");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_acceptances_doc_version_idx" ON "policy_acceptances" ("doc", "version");
--> statement-breakpoint
INSERT INTO "policy_versions" ("doc", "version", "summary", "requires_acceptance", "published_at", "reason")
VALUES
  ('terms', '2026-10-24', '{"en": "Baseline: the version in force when re-consent was introduced."}'::jsonb, false, '2026-10-24T00:00:00+05:30', 'baseline'),
  ('privacy-policy', '2026-10-24', '{"en": "Baseline: the version in force when re-consent was introduced."}'::jsonb, false, '2026-10-24T00:00:00+05:30', 'baseline'),
  ('seller-terms', '2026-10-24', '{"en": "Baseline: the version in force when re-consent was introduced."}'::jsonb, false, '2026-10-24T00:00:00+05:30', 'baseline')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('policy_reconsent_enabled', false) ON CONFLICT DO NOTHING;
