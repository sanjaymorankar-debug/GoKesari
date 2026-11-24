-- Guest checkout, guest order tracking, best-shop panel and order-group reconciliation
-- (owner brief 23-Nov-2026, Module 1; docs/guest-checkout-2026-11/README.md).
--
-- * users.guest_created: the account was made by guest checkout (contact details + a one-time code at the
--   cart, no sign-up form). Otherwise an ordinary customer account; the column only adds the
--   "track without signing in" link to its order e-mails.
-- * login_otps.purpose gains GUEST_MOBILE and ORDER_TRACK: text column with no CHECK, so nothing to change here.
-- * feature flag guest_checkout_enabled, seeded OFF (it also needs guest_cart_enabled ON to show anything).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0189.sql (drops the column and the flag row).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "guest_created" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
INSERT INTO "feature_flags" ("key", "enabled") VALUES ('guest_checkout_enabled', false) ON CONFLICT DO NOTHING;
