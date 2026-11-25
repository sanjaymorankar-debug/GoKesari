-- Referral sharing (docs/referral-sharing-2026-11): one row per share, link click, app first-open and
-- signup claim of a referral link (/r/<CODE>?c=<channel>). Tracking only: no reward or commission is
-- decided from this table; those stay with the existing referral tables (customer_referrals,
-- customer_signup_referrals, referral_redemptions, shop_referrals, dealer commission).
--
-- * code: the code shared or opened (upper case), kind: CUSTOMER / SHOP / DEALER / FRANCHISE / GOKESARI / UNKNOWN.
-- * referrer_user_id: the account that owns the code, when known (shares: the sharer).
-- * event: SHARE (a share button), CLICK (the link opened), APP_OPEN (first open of the app after a click),
--   CLAIM (the code was offered to a new account from a click without a cookie: deferred link).
-- * outcome: OK, SELF (own link), KEPT_FIRST (another valid link was opened first), CLOSED, EXPIRED,
--   INVALID, OFF (sharing switched off).
-- * ip_hash: sha256 of the visitor's address with AUTH_SECRET (never the address itself), for the deferred
--   match after an app install; kept 30 days in practice (rows are small; no purge job needed yet).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0209-referral-link-events.sql.
CREATE TABLE IF NOT EXISTS "referral_link_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "kind" text NOT NULL,
  "event" text NOT NULL,
  "channel" text,
  "outcome" text DEFAULT 'OK' NOT NULL,
  "referrer_user_id" uuid,
  "actor_user_id" uuid,
  "ip_hash" text,
  "in_app" boolean DEFAULT false NOT NULL,
  "claimed_by_user_id" uuid,
  "claimed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "referral_link_events_event_check" CHECK ("event" IN ('SHARE', 'CLICK', 'APP_OPEN', 'CLAIM')),
  CONSTRAINT "referral_link_events_kind_check" CHECK ("kind" IN ('CUSTOMER', 'SHOP', 'DEALER', 'FRANCHISE', 'GOKESARI', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_link_events_code_idx" ON "referral_link_events" ("code", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_link_events_referrer_idx" ON "referral_link_events" ("referrer_user_id", "created_at") WHERE "referrer_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_link_events_deferred_idx" ON "referral_link_events" ("ip_hash", "created_at") WHERE "event" = 'CLICK' AND "claimed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_link_events_created_idx" ON "referral_link_events" ("created_at");
