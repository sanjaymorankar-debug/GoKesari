-- Rollback for drizzle/0205_referral_link_events.sql (referral sharing). Drops the tracking table only;
-- no referral, reward or commission data lives in it.
DROP TABLE IF EXISTS "referral_link_events";
