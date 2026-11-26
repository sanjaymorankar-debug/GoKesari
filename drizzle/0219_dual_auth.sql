-- Dual authentication (docs/dual-auth-2026-11; owner brief 26-Nov-2026 23.28 IST). Flag `dual_auth`.
--
-- An account counts only when both its mobile (SMS code) and its e-mail (code, link or Google) are verified.
--
-- * users.needs_second_factor: TRUE for every live account with only one verified factor (or none). They can
--   still browse; orders, shop / dealer features and withdrawals ask for the missing factor first. Cleared by
--   the app as soon as both are verified. mobile = users.phone_verified_at; e-mail = users.email_verified, or a
--   linked Google account, on a real (non-placeholder) address. // DEFAULT – confirm with Sanjay: the brief's
--   mobile_verified_at / email_verified_at are these two existing columns (no duplicate columns).
-- * users.second_factor_reminded_at: last banner-SMS reminder to add an e-mail (mobile-only shop owners).
-- * trusted_devices: a browser / app that completed both factors for an account; trusted for 30 days.
-- * Flag dual_auth: ON on the staging database (gokesari_test), OFF everywhere else until the production pass.
--
-- Additive and safe to re-run. No account or data is deleted. Rollback: scripts/rollback-0219-dual-auth.sql.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needs_second_factor" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "needs_second_factor_since" timestamptz;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "second_factor_reminded_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- sha256 of the device token kept in the browser's httpOnly cookie gk_device (never the token itself).
  "device_hash" text NOT NULL,
  "user_agent" text,
  "ip_address" text,
  "trusted_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_user_device_unique" ON "trusted_devices" ("user_id", "device_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trusted_devices_expires_idx" ON "trusted_devices" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_needs_second_factor_idx" ON "users" ("needs_second_factor") WHERE "needs_second_factor" AND "deleted_at" IS NULL;
--> statement-breakpoint
-- One-factor accounts: no verified mobile, or no verified real e-mail (e-mail verified or Google linked).
UPDATE "users" u
SET "needs_second_factor" = true, "needs_second_factor_since" = COALESCE(u."needs_second_factor_since", now())
WHERE u."deleted_at" IS NULL
  AND u."needs_second_factor" = false
  AND (
    u."phone_e164" IS NULL
    OR u."phone_verified_at" IS NULL
    OR u."email_placeholder"
    OR (u."email_verified" IS NULL AND NOT EXISTS (SELECT 1 FROM "accounts" a WHERE a."user_id" = u."id" AND a."provider" = 'google'))
  );
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled")
VALUES ('dual_auth', current_database() = 'gokesari_test')
ON CONFLICT ("key") DO NOTHING;
