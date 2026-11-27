-- Super franchisee (owner, 27-Nov-2026; docs/super-franchisee/README.md).
--
-- * super_franchisees: dealers an admin made the head of a team of other dealers (free or paid franchisees).
--   Only an admin promotes, removes, and sets an optional own rate.
-- * super_franchisee_members: which team a dealer is in, with start and end (history kept; one open row per dealer).
-- * dealer_commission_ledger: entry types SUPER_FEE (X% of a fee paid in the team; a dealer's joining or franchise fee
--   has no shop) and SUPER_ORDER (Y% of GoKesari's monthly order commission on a team shop). Paid EXTRA by GoKesari.
-- Rule superFranchisee (enabled false, 300 / 200 bp) lives in the settings table with code defaults: nothing to seed,
-- and nothing is earned until an admin switches it on.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0226-super-franchisee.sql.

CREATE TABLE IF NOT EXISTS "super_franchisees" (
  "dealer_id" uuid PRIMARY KEY REFERENCES "dealers"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "fee_share_bp" integer,
  "order_share_bp" integer,
  "reason" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "removed_at" timestamp with time zone,
  "removed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "super_franchisees_status" CHECK ("status" IN ('ACTIVE', 'REMOVED')),
  CONSTRAINT "super_franchisees_fee_bp" CHECK ("fee_share_bp" IS NULL OR ("fee_share_bp" >= 0 AND "fee_share_bp" <= 10000)),
  CONSTRAINT "super_franchisees_order_bp" CHECK ("order_share_bp" IS NULL OR ("order_share_bp" >= 0 AND "order_share_bp" <= 10000))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "super_franchisee_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "super_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
  "member_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
  "starts_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ends_at" timestamp with time zone,
  "reason" text NOT NULL,
  "assigned_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "end_reason" text,
  "ended_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "super_franchisee_members_not_self" CHECK ("super_dealer_id" <> "member_dealer_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "super_franchisee_members_open_unique" ON "super_franchisee_members" ("member_dealer_id") WHERE "ends_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "super_franchisee_members_super_idx" ON "super_franchisee_members" ("super_dealer_id", "starts_at");
--> statement-breakpoint
DO $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'dealer_commission_ledger_entry_type' AND c.conrelid = 'public.dealer_commission_ledger'::regclass;
  IF def IS NOT NULL THEN
    SELECT array_agg(DISTINCT v) INTO vals FROM (
      SELECT (regexp_matches(def, '''([A-Z0-9_]+)''', 'g'))[1] AS v
      UNION SELECT unnest(ARRAY['SUPER_FEE', 'SUPER_ORDER'])
    ) s;
    EXECUTE 'ALTER TABLE public.dealer_commission_ledger DROP CONSTRAINT dealer_commission_ledger_entry_type';
    EXECUTE format('ALTER TABLE public.dealer_commission_ledger ADD CONSTRAINT dealer_commission_ledger_entry_type CHECK ("entry_type" IN (%s))',
      (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
  END IF;

  -- A joining or franchise fee has no shop: SUPER_FEE may have no shop_id (as BONUS and TERRITORY).
  def := NULL;
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'dealer_commission_ledger_shop' AND c.conrelid = 'public.dealer_commission_ledger'::regclass;
  IF def IS NOT NULL AND position('SUPER_FEE' in def) = 0 THEN
    SELECT array_agg(DISTINCT v) INTO vals FROM (
      SELECT (regexp_matches(def, '''([A-Z0-9_]+)''', 'g'))[1] AS v
      UNION SELECT 'SUPER_FEE'
    ) s;
    EXECUTE 'ALTER TABLE public.dealer_commission_ledger DROP CONSTRAINT dealer_commission_ledger_shop';
    EXECUTE format('ALTER TABLE public.dealer_commission_ledger ADD CONSTRAINT dealer_commission_ledger_shop CHECK ("shop_id" IS NOT NULL OR "entry_type" IN (%s))',
      (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
  END IF;
END $$;
