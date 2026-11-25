-- Dealer scheme decisions D1–D10, owner's answers of 25-Nov-2026 (docs/dealer-platform/PHASE_1_SCHEMES.md):
--   D1  Free Dealership: 20% of each shop's registration fee, one-time. No 5% monthly commission.
--   D2  Business Partner and Growth Partner stay switched off (suspended: no new applicants) for now.
--   D3  Their fees are before GST (18% added on top) when they open.
--   D4–D7 unchanged: zones and owners per zone as they are; no monthly commission is paid on any dealership.
--   D8  Existing dealers stay on Free Dealership version 1, their current terms.
--   D9  Admin roles: owner assigns people later.
--
-- * Free Dealership version 3 = version 2 without the monthly component; it replaces version 2 for new dealers.
-- * Dealers on version 2 (new since 23-Nov-2026) move to version 3: they keep the 20% one-time and lose the 5%
--   monthly (monthly commission is only written at a month close; November's runs in December).
-- * Business Partner and Growth Partner: SUSPENDED (admin can publish them again from Admin → Dealer schemes).
--
-- Safe to re-run.

INSERT INTO "dealer_scheme_versions" ("scheme_id", "version", "status", "label", "terms", "change_reason")
SELECT v.scheme_id, 3, 'DRAFT', 'Owner 25-Nov-2026: 20% one-time only',
  jsonb_set(
    jsonb_set(v.terms, '{components}', coalesce((SELECT jsonb_agg(c) FROM jsonb_array_elements(v.terms->'components') c WHERE c->>'kind' <> 'RECURRING'), '[]'::jsonb)),
    '{summary}', to_jsonb('Free dealership: no joining fee, work anywhere in India, 20% of the registration fee of every shop you register (one-time).'::text)
  ) #- '{benefits}' || jsonb_build_object('benefits', jsonb_build_array('No joining fee', 'Work anywhere in India')),
  'Owner decision D1, 25-Nov-2026: no 5% monthly commission'
FROM "dealer_scheme_versions" v JOIN "dealer_schemes" s ON s.id = v.scheme_id
WHERE s.code = 'FREE' AND v.version = 2
ON CONFLICT ("scheme_id", "version") DO NOTHING;
--> statement-breakpoint
UPDATE "dealer_scheme_versions" v SET "status" = 'SUPERSEDED', "updated_at" = now()
FROM "dealer_schemes" s
WHERE s.id = v.scheme_id AND s.code = 'FREE' AND v.status = 'PUBLISHED' AND v.version <> 3
  AND EXISTS (SELECT 1 FROM "dealer_scheme_versions" d WHERE d.scheme_id = s.id AND d.version = 3 AND d.status = 'DRAFT');
--> statement-breakpoint
UPDATE "dealer_scheme_versions" v SET "status" = 'PUBLISHED', "published_at" = now(), "effective_from" = now(), "updated_at" = now()
FROM "dealer_schemes" s
WHERE s.id = v.scheme_id AND s.code = 'FREE' AND v.version = 3 AND v.status = 'DRAFT'
  AND NOT EXISTS (SELECT 1 FROM "dealer_scheme_versions" p WHERE p.scheme_id = s.id AND p.status = 'PUBLISHED');
--> statement-breakpoint
-- Dealers on Free version 2 → version 3 (history kept: the old assignment is superseded, never changed).
WITH moved AS (
  UPDATE "dealer_scheme_assignments" a SET "status" = 'SUPERSEDED', "ends_at" = greatest(now(), a.starts_at),
    "end_reason" = 'Free Dealership version 3 (owner decision D1, 25-Nov-2026: no monthly commission)'
  FROM "dealer_scheme_versions" v JOIN "dealer_schemes" s ON s.id = v.scheme_id
  WHERE a.version_id = v.id AND a.status = 'ACTIVE' AND s.code = 'FREE' AND v.version = 2
    AND EXISTS (SELECT 1 FROM "dealer_scheme_versions" n WHERE n.scheme_id = s.id AND n.version = 3 AND n.status = 'PUBLISHED')
  RETURNING a.id, a.dealer_id, a.scheme_id
)
INSERT INTO "dealer_scheme_assignments" ("dealer_id", "scheme_id", "version_id", "status", "source", "accepted_terms", "previous_assignment_id", "reason")
SELECT m.dealer_id, m.scheme_id, n.id, 'ACTIVE', 'ADMIN', n.terms, m.id, 'owner decision D1, 25-Nov-2026: Free Dealership version 3'
FROM moved m JOIN "dealer_scheme_versions" n ON n.scheme_id = m.scheme_id AND n.version = 3;
--> statement-breakpoint
UPDATE "dealer_schemes" SET "status" = 'SUSPENDED', "launch_at" = NULL, "updated_at" = now()
WHERE "code" IN ('BUSINESS_PARTNER', 'GROWTH_PARTNER') AND "status" IN ('PUBLISHED', 'SCHEDULED');
