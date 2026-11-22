-- Owner, 21-Nov-2026 evening: two dealer models, every rate editable by an admin.
--   1. Free dealership (no upfront fee): one-time only, 20% / 4% / 3% (rule dealerTieredCommission, unchanged).
--   2. Franchise (zone bought upfront): one-time 25% on the owner's own shop, the same 20/4/3 flow on team shops
--      (owner 4% one level up, 3% two levels up — was a flat 5%), and recurring 20% of GoKesari's order
--      commission (was 25%).
-- The site's franchise settings get a new version in force now (the owner asked for it now, so it does not wait for
-- the usual next-month start of money changes). A site with no stored version yet takes the new code defaults.
INSERT INTO "franchise_config_versions" ("version", "effective_from", "config", "reason")
SELECT (SELECT max("version") FROM "franchise_config_versions") + 1,
       now(),
       cur."config" || '{"ownerOverrideBp":400,"ownerSecondOverrideBp":300,"recurringBaseBp":2000}'::jsonb,
       'Owner 21-Nov-2026: franchise team shops follow 20/4/3 (owner 4% / 3%); recurring 20% of GoKesari commission'
FROM (
  SELECT "config" FROM "franchise_config_versions"
  WHERE "effective_from" <= now()
  ORDER BY "effective_from" DESC, "version" DESC
  LIMIT 1
) cur;
--> statement-breakpoint
-- A version already scheduled for later carries the change too (it would otherwise undo it).
UPDATE "franchise_config_versions"
SET "config" = "config" || '{"ownerOverrideBp":400,"ownerSecondOverrideBp":300,"recurringBaseBp":2000}'::jsonb
WHERE "effective_from" > now();
--> statement-breakpoint
-- Owner, 21-Nov-2026: a territory and a franchise are the same thing. The older territory-dealer rule (its own
-- recurring 20-25% share) is switched off so a shop's orders are never paid twice; territories are sold as franchise
-- zones. No territory had been given on either site when this ran.
UPDATE "platform_settings" SET "value" = "value" || '{"enabled":false}'::jsonb, "updated_at" = now() WHERE "key" = 'territoryDealer';
