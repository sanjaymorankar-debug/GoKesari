-- Dealership & Franchise Platform, Phase 3: the scheme calculator (owner brief 23-Nov-2026;
-- docs/dealer-platform/PHASE_3_CALCULATOR.md).
--
-- * dealer_commission_ledger: entry types SCHEME_ONE_TIME, SCHEME_TEAM, SCHEME_RECURRING, SCHEME_BONUS, and which
--   scheme assignment and component a line came from. Same ledger, same payouts, holds, reversals and statements.
-- * Publishes the brief's terms (owner decisions D1–D3, D7): Free Dealership version 2 (20% + 5% monthly for 12
--   months) replaces version 1 for NEW dealers; existing dealers keep version 1 (their assignment is unchanged —
--   D8). Business Partner (₹11,000 + GST) and Growth Partner (₹21,000 + GST) open for applications.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0179.sql.

ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "scheme_assignment_id" uuid REFERENCES "dealer_scheme_assignments"("id");
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "scheme_component_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_scheme_idx" ON "dealer_commission_ledger" ("scheme_assignment_id") WHERE "scheme_assignment_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'dealer_commission_ledger_entry_type' AND c.conrelid = 'public.dealer_commission_ledger'::regclass;
  IF def IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT v) INTO vals FROM (
    SELECT (regexp_matches(def, '''([A-Z0-9_]+)''', 'g'))[1] AS v
    UNION SELECT unnest(ARRAY['SCHEME_ONE_TIME', 'SCHEME_TEAM', 'SCHEME_RECURRING', 'SCHEME_BONUS'])
  ) s;
  EXECUTE 'ALTER TABLE public.dealer_commission_ledger DROP CONSTRAINT dealer_commission_ledger_entry_type';
  EXECUTE format('ALTER TABLE public.dealer_commission_ledger ADD CONSTRAINT dealer_commission_ledger_entry_type CHECK ("entry_type" IN (%s))',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
-- Free Dealership: version 1 (terms before 23-Nov-2026) stays with the dealers on it; version 2 is offered from now.
UPDATE "dealer_scheme_versions" v SET "status" = 'SUPERSEDED', "updated_at" = now()
FROM "dealer_schemes" s
WHERE s.id = v.scheme_id AND s.code = 'FREE' AND v.version = 1 AND v.status = 'PUBLISHED'
  AND EXISTS (SELECT 1 FROM "dealer_scheme_versions" d WHERE d.scheme_id = s.id AND d.version = 2 AND d.status = 'DRAFT');
--> statement-breakpoint
UPDATE "dealer_scheme_versions" v SET "status" = 'PUBLISHED', "published_at" = now(), "effective_from" = now(), "updated_at" = now(),
  "change_reason" = coalesce(v.change_reason, '') || ' — published with the scheme calculator (0179)'
FROM "dealer_schemes" s
WHERE s.id = v.scheme_id AND v.status = 'DRAFT'
  AND ((s.code = 'FREE' AND v.version = 2) OR (s.code IN ('BUSINESS_PARTNER', 'GROWTH_PARTNER') AND v.version = 1))
  AND NOT EXISTS (SELECT 1 FROM "dealer_scheme_versions" p WHERE p.scheme_id = s.id AND p.status = 'PUBLISHED');
--> statement-breakpoint
UPDATE "dealer_schemes" SET "status" = 'PUBLISHED', "updated_at" = now()
WHERE "code" IN ('BUSINESS_PARTNER', 'GROWTH_PARTNER') AND "status" = 'DRAFT';
