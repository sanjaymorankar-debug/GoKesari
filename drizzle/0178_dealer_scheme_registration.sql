-- Dealership & Franchise Platform, Phase 2: one registration for every scheme (owner brief 23-Nov-2026;
-- docs/dealer-platform/PHASE_2_REGISTRATION.md).
--
-- * dealers.requested_version_id: the scheme version the applicant chose on /dealer/apply.
-- * dealer_scheme_acceptances: every time a dealer accepts a scheme version's terms — the terms' fingerprint, time,
--   IP and browser. Append-only (trigger).
-- * dealer_joining_payments: the joining charge of a paid scheme (base, GST, total), paid online through the
--   existing payment gateway (payment-intent purpose DEALER_JOINING_FEE). One open or paid charge per dealer and
--   version. Refunded through the gateway when the application is rejected.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0178.sql.

ALTER TABLE "dealers" ADD COLUMN IF NOT EXISTS "requested_version_id" uuid REFERENCES "dealer_scheme_versions"("id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_scheme_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id"),
  "version_id" uuid NOT NULL REFERENCES "dealer_scheme_versions"("id"),
  "terms_hash" text NOT NULL,
  "context" text NOT NULL,
  "accepted_by" uuid,
  "accepted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ip_address" text,
  "user_agent" text,
  CONSTRAINT "dealer_scheme_acceptances_context" CHECK ("context" IN ('APPLICATION', 'UPGRADE', 'DOWNGRADE', 'CHANGE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_scheme_acceptances_dealer_idx" ON "dealer_scheme_acceptances" ("dealer_id", "accepted_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dealer_scheme_acceptances_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dealer_scheme_acceptances: acceptances are a record and cannot be changed or deleted';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS dealer_scheme_acceptances_append_only ON "dealer_scheme_acceptances";
--> statement-breakpoint
CREATE TRIGGER dealer_scheme_acceptances_append_only BEFORE UPDATE OR DELETE ON "dealer_scheme_acceptances"
  FOR EACH ROW EXECUTE FUNCTION dealer_scheme_acceptances_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_joining_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dealer_id" uuid NOT NULL REFERENCES "dealers"("id"),
  "version_id" uuid NOT NULL REFERENCES "dealer_scheme_versions"("id"),
  "base_paise" bigint NOT NULL,
  "gst_rate_bp" integer NOT NULL,
  "gst_paise" bigint NOT NULL,
  "total_paise" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING',
  "payment_intent_id" uuid,
  "paid_at" timestamp with time zone,
  "refund_id" uuid,
  "refund_reason" text,
  "refunded_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dealer_joining_payments_status" CHECK ("status" IN ('PENDING', 'PAID', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED')),
  CONSTRAINT "dealer_joining_payments_amounts" CHECK ("base_paise" > 0 AND "gst_paise" >= 0 AND "total_paise" = "base_paise" + "gst_paise")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_joining_payments_open_uq" ON "dealer_joining_payments" ("dealer_id", "version_id") WHERE "status" IN ('PENDING', 'PAID');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_joining_payments_intent_uq" ON "dealer_joining_payments" ("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  def text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'payment_intents_purpose_check' AND c.conrelid = 'public.payment_intents'::regclass;
  IF def IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT v) INTO vals FROM (
    SELECT (regexp_matches(def, '''([A-Z_]+)''', 'g'))[1] AS v
    UNION SELECT unnest(ARRAY['DEALER_JOINING_FEE'])
  ) s;
  EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
  EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
