-- Rollback of drizzle/0217_onboarding_v2_shop.sql (docs/onboarding-v2-2026-11, Flow 2 shop onboarding).
-- Before running: switch the flag off (Admin → Feature flags → onboarding_v2), deploy the previous release's
-- code, then delete the 0217 row from drizzle.__drizzle_migrations. Idempotent.
-- Refuses while a draft-fee payment intent exists: those rows would break the narrowed constraint, and they
-- are the record of money taken.
BEGIN;
DO $$
DECLARE
  def text;
  vals text[];
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents WHERE purpose = 'SHOP_REGISTRATION_DRAFT_FEE') THEN
    RAISE EXCEPTION 'Draft registration-fee payment intents exist: keep 0217 (the code that reads them can be rolled back on its own)';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'payment_intents_purpose_check' AND c.conrelid = 'public.payment_intents'::regclass;
  IF def IS NOT NULL THEN
    SELECT array_agg(DISTINCT v) INTO vals FROM (
      SELECT (regexp_matches(def, '''([A-Z_]+)''', 'g'))[1] AS v
    ) s WHERE v <> 'SHOP_REGISTRATION_DRAFT_FEE';
    EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
    EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
      (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
  END IF;
END $$;
DROP TABLE IF EXISTS "registration_licence_files";
ALTER TABLE "registration_licence_entries" DROP COLUMN IF EXISTS "reviewed_by", DROP COLUMN IF EXISTS "reviewed_at";
COMMIT;
