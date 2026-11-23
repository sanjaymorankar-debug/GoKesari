-- Dealership & Franchise Platform, Phase 1: schemes, scheme versions and each dealer's scheme assignment
-- (owner brief 23-Nov-2026, defaults accepted 09.20 IST; docs/dealer-platform/).
--
-- * dealer_schemes: one row per commercial scheme (Free Dealership, Business Partner, Growth Partner, Territory
--   Franchise, and any the admin adds later).
-- * dealer_scheme_versions: the terms of a scheme as validated JSON (src/lib/dealer-schemes.ts). A version can be
--   edited only while DRAFT; once published its terms never change (trigger), so a dealer's agreement is never
--   rewritten. terms_hash is the SHA-256 of the stored terms, computed here.
-- * dealer_scheme_assignments: which version each dealer is on, with a copy of the terms. History is kept: a change
--   of scheme ends the old row and adds a new one; rows are never deleted (trigger).
--
-- Commission is still calculated by the existing code in this phase (terms.calculation LEGACY_DEALER /
-- LEGACY_FRANCHISE). Existing dealers stay on their current terms (owner decision D8): "Free Dealership" version 1
-- describes those terms; version 2 (the brief's 20% + 5% monthly) is a DRAFT until the scheme calculator ships.
-- Business Partner and Growth Partner are DRAFT until registration can take their fee.
--
-- Also dealers.logo_url: the dealer's own logo (reuses the shop logo upload, CF-011).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0177.sql.

ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "logo_url" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "dealer_schemes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "sort_order" integer NOT NULL DEFAULT 100,
  "launch_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dealer_schemes_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  CONSTRAINT "dealer_schemes_category" CHECK ("category" IN ('DEALERSHIP', 'FRANCHISE')),
  CONSTRAINT "dealer_schemes_status" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'SUSPENDED', 'EXPIRED', 'ARCHIVED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_schemes_code_uq" ON "dealer_schemes" ("code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_scheme_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scheme_id" uuid NOT NULL REFERENCES "dealer_schemes"("id"),
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'DRAFT',
  "label" text,
  "terms" jsonb NOT NULL,
  "terms_hash" text NOT NULL DEFAULT '',
  "change_reason" text,
  "effective_from" timestamp with time zone,
  "published_at" timestamp with time zone,
  "published_by" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dealer_scheme_versions_status" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN')),
  CONSTRAINT "dealer_scheme_versions_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_scheme_versions_scheme_version_uq" ON "dealer_scheme_versions" ("scheme_id", "version");
--> statement-breakpoint
-- At most one version of a scheme is offered to new dealers at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_scheme_versions_one_published_uq" ON "dealer_scheme_versions" ("scheme_id") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_scheme_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id"),
  "scheme_id" uuid NOT NULL REFERENCES "dealer_schemes"("id"),
  "version_id" uuid NOT NULL REFERENCES "dealer_scheme_versions"("id"),
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "source" text NOT NULL,
  "starts_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ends_at" timestamp with time zone,
  "end_reason" text,
  "accepted_terms" jsonb NOT NULL,
  "terms_hash" text NOT NULL DEFAULT '',
  "accepted_at" timestamp with time zone,
  "accepted_ip" text,
  "accepted_user_agent" text,
  "previous_assignment_id" uuid REFERENCES "dealer_scheme_assignments"("id"),
  "reason" text,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dealer_scheme_assignments_status" CHECK ("status" IN ('ACTIVE', 'SUPERSEDED', 'ENDED')),
  CONSTRAINT "dealer_scheme_assignments_source" CHECK ("source" IN ('MIGRATION', 'AUTO', 'REGISTRATION', 'FRANCHISE_BOOKING', 'FRANCHISE_ENDED', 'UPGRADE', 'DOWNGRADE', 'ADMIN')),
  CONSTRAINT "dealer_scheme_assignments_dates" CHECK ("ends_at" IS NULL OR "ends_at" >= "starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_scheme_assignments_one_active_uq" ON "dealer_scheme_assignments" ("dealer_id") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_scheme_assignments_dealer_idx" ON "dealer_scheme_assignments" ("dealer_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_scheme_assignments_version_idx" ON "dealer_scheme_assignments" ("version_id");
--> statement-breakpoint

-- Published terms never change; versions other than drafts are never deleted.
CREATE OR REPLACE FUNCTION dealer_scheme_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'dealer_scheme_versions: version % of scheme % is %; only drafts can be deleted', OLD.version, OLD.scheme_id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'DRAFT' AND (NEW.terms IS DISTINCT FROM OLD.terms OR NEW.version <> OLD.version OR NEW.scheme_id <> OLD.scheme_id) THEN
      RAISE EXCEPTION 'dealer_scheme_versions: the terms of a % version cannot change; create a new version', OLD.status;
    END IF;
    IF OLD.status <> NEW.status AND NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'WITHDRAWN')) OR
      (OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED')
    ) THEN
      RAISE EXCEPTION 'dealer_scheme_versions: status % cannot become %', OLD.status, NEW.status;
    END IF;
  END IF;
  NEW.terms_hash := encode(sha256(convert_to(NEW.terms::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dealer_scheme_versions_guard ON "dealer_scheme_versions";
--> statement-breakpoint
CREATE TRIGGER dealer_scheme_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "dealer_scheme_versions"
  FOR EACH ROW EXECUTE FUNCTION dealer_scheme_versions_guard();
--> statement-breakpoint

-- Assignments are history: only an ACTIVE row may be closed (status, ends_at, end_reason); nothing is deleted.
CREATE OR REPLACE FUNCTION dealer_scheme_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dealer_scheme_assignments: scheme history cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'dealer_scheme_assignments: a % assignment cannot change', OLD.status;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'ends_at', 'end_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'ends_at', 'end_reason']) THEN
      RAISE EXCEPTION 'dealer_scheme_assignments: only status, ends_at and end_reason can change';
    END IF;
    RETURN NEW;
  END IF;
  NEW.terms_hash := encode(sha256(convert_to(NEW.accepted_terms::text, 'UTF8')), 'hex');
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dealer_scheme_assignments_guard ON "dealer_scheme_assignments";
--> statement-breakpoint
CREATE TRIGGER dealer_scheme_assignments_guard BEFORE INSERT OR UPDATE OR DELETE ON "dealer_scheme_assignments"
  FOR EACH ROW EXECUTE FUNCTION dealer_scheme_assignments_guard();
--> statement-breakpoint

-- Puts a dealer on a scheme (by code). Keeps him on the version he last had of that scheme (existing terms are
-- protected), else the published version. No-op when he is already on that scheme or the scheme has no version.
CREATE OR REPLACE FUNCTION dealer_scheme_assign(p_dealer uuid, p_code text, p_source text, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_scheme uuid;
  v_version uuid;
  v_terms jsonb;
  v_current_id uuid;
  v_current_scheme uuid;
BEGIN
  SELECT id INTO v_scheme FROM dealer_schemes WHERE code = p_code;
  IF v_scheme IS NULL THEN RETURN; END IF;
  SELECT id, scheme_id INTO v_current_id, v_current_scheme FROM dealer_scheme_assignments
    WHERE dealer_id = p_dealer AND status = 'ACTIVE' FOR UPDATE;
  IF v_current_scheme = v_scheme THEN RETURN; END IF;
  SELECT a.version_id INTO v_version FROM dealer_scheme_assignments a
    WHERE a.dealer_id = p_dealer AND a.scheme_id = v_scheme ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 1;
  IF v_version IS NULL THEN
    SELECT id INTO v_version FROM dealer_scheme_versions WHERE scheme_id = v_scheme AND status = 'PUBLISHED';
  END IF;
  IF v_version IS NULL THEN RETURN; END IF;
  SELECT terms INTO v_terms FROM dealer_scheme_versions WHERE id = v_version;
  IF v_current_id IS NOT NULL THEN
    UPDATE dealer_scheme_assignments SET status = 'SUPERSEDED', ends_at = greatest(now(), starts_at), end_reason = p_reason WHERE id = v_current_id;
  END IF;
  INSERT INTO dealer_scheme_assignments (dealer_id, scheme_id, version_id, status, source, accepted_terms, previous_assignment_id, reason)
    VALUES (p_dealer, v_scheme, v_version, 'ACTIVE', p_source, v_terms, v_current_id, p_reason);
END $$;
--> statement-breakpoint

-- Every new dealer (application, franchise pay-first, admin, legacy) starts on the Free Dealership.
CREATE OR REPLACE FUNCTION dealers_default_scheme() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.is_internal THEN
    PERFORM dealer_scheme_assign(NEW.id, 'FREE', 'AUTO', 'new dealer');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dealers_default_scheme ON "dealers";
--> statement-breakpoint
CREATE TRIGGER dealers_default_scheme AFTER INSERT ON "dealers" FOR EACH ROW EXECUTE FUNCTION dealers_default_scheme();
--> statement-breakpoint

-- A dealer with a paid (ACTIVE or SUSPENDED, not test) franchise allocation is on the Territory Franchise scheme;
-- when his last one ends (expiry, refund, cancellation) he goes back to the dealership scheme he had before.
CREATE OR REPLACE FUNCTION franchise_allocations_scheme_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_paid boolean;
  v_on_franchise boolean;
  v_back text;
BEGIN
  IF NEW.is_test THEN RETURN NULL; END IF;
  SELECT EXISTS (SELECT 1 FROM franchise_allocations WHERE owner_dealer_id = NEW.owner_dealer_id AND NOT is_test AND status IN ('ACTIVE', 'SUSPENDED')) INTO v_paid;
  SELECT EXISTS (SELECT 1 FROM dealer_scheme_assignments a JOIN dealer_schemes s ON s.id = a.scheme_id
    WHERE a.dealer_id = NEW.owner_dealer_id AND a.status = 'ACTIVE' AND s.code = 'TERRITORY_FRANCHISE') INTO v_on_franchise;
  IF v_paid AND NOT v_on_franchise THEN
    PERFORM dealer_scheme_assign(NEW.owner_dealer_id, 'TERRITORY_FRANCHISE', 'FRANCHISE_BOOKING', 'franchise zone ' || NEW.zone_id || ' paid');
  ELSIF NOT v_paid AND v_on_franchise THEN
    SELECT s.code INTO v_back FROM dealer_scheme_assignments a JOIN dealer_schemes s ON s.id = a.scheme_id
      WHERE a.dealer_id = NEW.owner_dealer_id AND s.category = 'DEALERSHIP' ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 1;
    PERFORM dealer_scheme_assign(NEW.owner_dealer_id, coalesce(v_back, 'FREE'), 'FRANCHISE_ENDED', 'franchise ended: zone ' || NEW.zone_id || ' ' || lower(NEW.status));
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS franchise_allocations_scheme_sync ON "franchise_allocations";
--> statement-breakpoint
CREATE TRIGGER franchise_allocations_scheme_sync AFTER INSERT OR UPDATE OF status ON "franchise_allocations"
  FOR EACH ROW EXECUTE FUNCTION franchise_allocations_scheme_sync();
--> statement-breakpoint

-- Seed schemes (amounts in paise, rates in basis points: 2000 = 20%).
INSERT INTO "dealer_schemes" ("code", "name", "category", "status", "sort_order") VALUES
  ('FREE', 'Free Dealership', 'DEALERSHIP', 'PUBLISHED', 10),
  ('BUSINESS_PARTNER', 'Business Partner', 'DEALERSHIP', 'DRAFT', 20),
  ('GROWTH_PARTNER', 'Growth Partner', 'DEALERSHIP', 'DRAFT', 30),
  ('TERRITORY_FRANCHISE', 'Territory Franchise', 'FRANCHISE', 'PUBLISHED', 40)
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "dealer_scheme_versions" ("scheme_id", "version", "status", "label", "terms", "change_reason", "effective_from", "published_at")
SELECT s.id, v.version, v.status, v.label, v.terms::jsonb, v.reason,
       CASE WHEN v.status = 'PUBLISHED' THEN now() END, CASE WHEN v.status = 'PUBLISHED' THEN now() END
FROM (VALUES
  ('FREE', 1, 'PUBLISHED', 'Terms before 23-Nov-2026',
   '{"summary":"Free dealership on the terms in force before 23-Nov-2026: no joining fee, work anywhere in India, one-time commission on the registration fee of the shops you bring, as set in Dealer commission (standard or 3-level team model). No monthly commission.","calculation":"LEGACY_DEALER","charge":{"kind":"FREE","amountPaise":0,"gstRateBp":0,"gstMode":"EXCLUSIVE","refundable":false},"validityMonths":null,"renewal":{"allowed":true,"chargePaise":0,"windowDays":30},"geography":{"scope":"ALL_INDIA","codes":[]},"exclusivity":"NONE","maxDealersPerTerritory":null,"territoryBooking":false,"teamBuilding":true,"commissionBudgetBp":null,"components":[{"id":"one-time","label":"One-time commission on shop registration fee (rate set in Dealer commission)","kind":"ONE_TIME","basis":"LEGACY","frequency":"ONCE","shopScope":"OWN","durationMonths":null}],"benefits":["No joining fee","Work anywhere in India"],"eligibility":[],"paymentConditions":[]}',
   'Existing dealers keep their current terms (owner decision D8, 23-Nov-2026)'),
  ('FREE', 2, 'DRAFT', 'Brief 23-Nov-2026',
   '{"summary":"Free dealership: no joining fee, work anywhere in India, 20% of the registration fee of every shop you register and 5% of GoKesari''s commission on those shops every month for 12 months.","calculation":"SCHEME","charge":{"kind":"FREE","amountPaise":0,"gstRateBp":0,"gstMode":"EXCLUSIVE","refundable":false},"validityMonths":12,"renewal":{"allowed":true,"chargePaise":0,"windowDays":30},"geography":{"scope":"ALL_INDIA","codes":[]},"exclusivity":"NONE","maxDealersPerTerritory":null,"territoryBooking":false,"teamBuilding":false,"commissionBudgetBp":null,"components":[{"id":"registration","label":"Shop registration commission","kind":"ONE_TIME","basis":"SHOP_REGISTRATION_FEE","rateBp":2000,"frequency":"ONCE","shopScope":"OWN","durationMonths":null},{"id":"monthly","label":"Monthly commission on GoKesari''s commission","kind":"RECURRING","basis":"PLATFORM_COMMISSION","rateBp":500,"frequency":"MONTHLY","shopScope":"OWN","durationMonths":12}],"benefits":["No joining fee","Work anywhere in India","Monthly income from your shops"],"eligibility":[],"paymentConditions":[]}',
   'Owner brief 23-Nov-2026 (D1); published when the scheme calculator ships'),
  ('BUSINESS_PARTNER', 1, 'DRAFT', 'Brief 23-Nov-2026',
   '{"summary":"Business Partner: ₹11,000 + GST joining fee, work anywhere in India, 25% of the registration fee of every shop you register and 15% of GoKesari''s commission on those shops every month for 12 months.","calculation":"SCHEME","charge":{"kind":"ONE_TIME","amountPaise":1100000,"gstRateBp":1800,"gstMode":"EXCLUSIVE","refundable":false},"validityMonths":12,"renewal":{"allowed":true,"chargePaise":0,"windowDays":30},"geography":{"scope":"ALL_INDIA","codes":[]},"exclusivity":"NONE","maxDealersPerTerritory":null,"territoryBooking":false,"teamBuilding":false,"commissionBudgetBp":null,"components":[{"id":"registration","label":"Shop registration commission","kind":"ONE_TIME","basis":"SHOP_REGISTRATION_FEE","rateBp":2500,"frequency":"ONCE","shopScope":"OWN","durationMonths":null},{"id":"monthly","label":"Monthly commission on GoKesari''s commission","kind":"RECURRING","basis":"PLATFORM_COMMISSION","rateBp":1500,"frequency":"MONTHLY","shopScope":"OWN","durationMonths":12}],"benefits":["Higher one-time and monthly commission","Work anywhere in India"],"eligibility":[],"paymentConditions":["Joining fee paid online before approval"]}',
   'Owner brief 23-Nov-2026 (D2, D3, D7); published when registration can take the fee'),
  ('GROWTH_PARTNER', 1, 'DRAFT', 'Brief 23-Nov-2026',
   '{"summary":"Growth Partner: ₹21,000 + GST joining fee, work anywhere in India, build your own team, 30% of the registration fee of every shop you register and 25% of GoKesari''s commission on those shops every month for 12 months, plus team commission.","calculation":"SCHEME","charge":{"kind":"ONE_TIME","amountPaise":2100000,"gstRateBp":1800,"gstMode":"EXCLUSIVE","refundable":false},"validityMonths":12,"renewal":{"allowed":true,"chargePaise":0,"windowDays":30},"geography":{"scope":"ALL_INDIA","codes":[]},"exclusivity":"NONE","maxDealersPerTerritory":null,"territoryBooking":false,"teamBuilding":true,"commissionBudgetBp":null,"components":[{"id":"registration","label":"Shop registration commission","kind":"ONE_TIME","basis":"SHOP_REGISTRATION_FEE","rateBp":3000,"frequency":"ONCE","shopScope":"OWN","durationMonths":null},{"id":"monthly","label":"Monthly commission on GoKesari''s commission","kind":"RECURRING","basis":"PLATFORM_COMMISSION","rateBp":2500,"frequency":"MONTHLY","shopScope":"OWN","durationMonths":12},{"id":"team-lead","label":"Team commission: shops of your team leads'' agents","kind":"TEAM_OVERRIDE","basis":"SHOP_REGISTRATION_FEE","rateBp":400,"frequency":"ONCE","shopScope":"TEAM","level":1,"durationMonths":null},{"id":"team-main","label":"Team commission: shops two levels down","kind":"TEAM_OVERRIDE","basis":"SHOP_REGISTRATION_FEE","rateBp":300,"frequency":"ONCE","shopScope":"TEAM","level":2,"durationMonths":null}],"benefits":["Highest commission","Build your own team","Work anywhere in India"],"eligibility":[],"paymentConditions":["Joining fee paid online before approval"]}',
   'Owner brief 23-Nov-2026 (D2, D3, D7); published when registration can take the fee'),
  ('TERRITORY_FRANCHISE', 1, 'PUBLISHED', 'Franchise in force on 23-Nov-2026',
   '{"summary":"Territory franchise: book a franchise zone for 12 months (₹1,50,000 + GST launch fee). In your zone you earn 25% on the shops you register, 4% and 3% on your team''s shops, and 20% of GoKesari''s commission on the zone''s shops every month, plus a monthly bonus of up to 5%. Up to 2 franchise owners per zone. Outside your zone you earn as a free dealer. The amounts follow Admin → Franchise → Settings.","calculation":"LEGACY_FRANCHISE","charge":{"kind":"ONE_TIME","amountPaise":15000000,"gstRateBp":1800,"gstMode":"EXCLUSIVE","refundable":false},"validityMonths":12,"renewal":{"allowed":true,"chargePaise":null,"windowDays":30},"geography":{"scope":"ZONE","codes":[]},"exclusivity":"SHARED","maxDealersPerTerritory":2,"territoryBooking":true,"teamBuilding":true,"commissionBudgetBp":null,"components":[{"id":"own-shops","label":"Your own shops in your zone","kind":"ONE_TIME","basis":"SHOP_REGISTRATION_FEE","rateBp":2500,"frequency":"ONCE","shopScope":"OWN","durationMonths":null},{"id":"team-1","label":"Team shops, one level down","kind":"TEAM_OVERRIDE","basis":"SHOP_REGISTRATION_FEE","rateBp":400,"frequency":"ONCE","shopScope":"TEAM","level":1,"durationMonths":null},{"id":"team-2","label":"Team shops, two levels down","kind":"TEAM_OVERRIDE","basis":"SHOP_REGISTRATION_FEE","rateBp":300,"frequency":"ONCE","shopScope":"TEAM","level":2,"durationMonths":null},{"id":"monthly","label":"Monthly commission on GoKesari''s commission in your zone","kind":"RECURRING","basis":"PLATFORM_COMMISSION","rateBp":2000,"frequency":"MONTHLY","shopScope":"ALL","durationMonths":null},{"id":"bonus","label":"Monthly points bonus (up to)","kind":"PERFORMANCE_BONUS","basis":"PLATFORM_COMMISSION","rateBp":500,"frequency":"MONTHLY","shopScope":"ALL","durationMonths":null}],"benefits":["Franchise zone for 12 months","Monthly income from every shop in your zone","Build your own team"],"eligibility":["KYC and bank verified within 30 days of payment"],"paymentConditions":["100% online payment at booking"]}',
   'Existing franchise terms (franchise config version 2) recorded as a scheme')
) AS v(code, version, status, label, terms, reason)
JOIN "dealer_schemes" s ON s.code = v.code
ON CONFLICT ("scheme_id", "version") DO NOTHING;
--> statement-breakpoint

-- Existing dealers: franchise owners with a paid zone on the franchise scheme, everyone else (except GoKesari
-- Direct) on Free Dealership version 1, their current terms.
INSERT INTO "dealer_scheme_assignments" ("dealer_id", "scheme_id", "version_id", "status", "source", "starts_at", "accepted_terms", "accepted_at", "reason")
SELECT d.id, s.id, v.id, 'ACTIVE', 'MIGRATION', least(d.created_at, now()), v.terms,
       CASE WHEN s.code = 'FREE' THEN d.agreement_accepted_at END,
       'existing dealer on 23-Nov-2026'
FROM "dealers" d
JOIN "dealer_schemes" s ON s.code = CASE
  WHEN EXISTS (SELECT 1 FROM "franchise_allocations" fa WHERE fa.owner_dealer_id = d.id AND NOT fa.is_test AND fa.status IN ('ACTIVE', 'SUSPENDED')) THEN 'TERRITORY_FRANCHISE'
  ELSE 'FREE' END
JOIN "dealer_scheme_versions" v ON v.scheme_id = s.id AND v.version = 1
WHERE NOT d.is_internal
  AND NOT EXISTS (SELECT 1 FROM "dealer_scheme_assignments" a WHERE a.dealer_id = d.id);
