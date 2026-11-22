-- Franchise zones: free dealership or paid franchise (owner, 22-Nov-2026; docs/franchise/FREE_OR_PAID_FLOW.md).
-- Additive and safe to re-run:
--   * every zone name starts with its city ("Pune – Koregaon Park–Mundhwa"); the city is the zone set's name
--     without a bracketed part ("Mumbai (Konkan)" → "Mumbai"); names already prefixed and test zones are left alone;
--   * franchise_allocations.kyc_due_at: paid before the owner's KYC — the zone is his, but it is live (code, team
--     shops, commission) only once KYC and bank are approved; kyc_cleared_at records when it went live;
--   * dealers.preferred_zone_id: the zone a free dealer chose to work in (no ownership).
-- Rollback: scripts/rollback-0164.sql.

UPDATE "franchise_zones" AS z
SET "name" = regexp_replace(s."name", '\s*\(.*\)\s*$', '') || ' – ' || z."name", "updated_at" = now()
FROM "franchise_zone_sets" AS s
WHERE s."code" = z."zone_set_code"
  AND NOT z."is_test"
  AND z."name" NOT LIKE regexp_replace(s."name", '\s*\(.*\)\s*$', '') || ' – %';
--> statement-breakpoint
ALTER TABLE "franchise_allocations" ADD COLUMN IF NOT EXISTS "kyc_due_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "franchise_allocations" ADD COLUMN IF NOT EXISTS "kyc_cleared_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_allocations_kyc_due_idx" ON "franchise_allocations" ("kyc_due_at") WHERE "kyc_due_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "preferred_zone_id" text;
