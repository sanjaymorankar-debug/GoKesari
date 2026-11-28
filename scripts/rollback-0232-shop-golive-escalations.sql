-- Rollback of drizzle/0232_shop_golive_escalations.sql (v2 / v3 go-live rule + support escalations).
-- Deploy the previous release's code first, then run this and delete the 0232 row from drizzle.__drizzle_migrations.
-- Open escalations and review flags are lost (export them first if they should be kept):
--   \copy support_escalations TO 'support_escalations.csv' CSV HEADER
--   \copy support_escalation_events TO 'support_escalation_events.csv' CSV HEADER
--   \copy shop_review_flags TO 'shop_review_flags.csv' CSV HEADER
-- A v2 / v3 shop held for a duplicate GSTIN / PAN stays PENDING_APPROVAL in Admin → Shops, as before.
DELETE FROM "platform_settings" WHERE "key" = 'supportEscalation';
DROP TABLE IF EXISTS "support_escalation_events";
DROP TABLE IF EXISTS "support_escalations";
DROP TABLE IF EXISTS "shop_review_flags";
