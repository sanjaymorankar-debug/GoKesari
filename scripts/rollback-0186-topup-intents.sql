-- Rollback for 0186_topup_payment_intents (PAY-2, docs/payments-topups-via-intents-2026-11).
-- Before running: switch rule topupPaymentIntents off, wait until no top-up intent is live, deploy the
-- previous release's code, then delete the 0186 row from drizzle.__drizzle_migrations.
-- Refuses while any top-up intent exists: those rows would break the narrowed constraint. Their
-- payments rows (gateway 'INTENT') are the wallet's record and must stay.
BEGIN;
DO $$
DECLARE
  def text;
  vals text[];
BEGIN
  IF EXISTS (SELECT 1 FROM payment_intents WHERE purpose IN ('WALLET_TOPUP', 'SHOP_WALLET_TOPUP')) THEN
    RAISE EXCEPTION 'Top-up payment intents exist: keep 0186 (the code that reads them can be rolled back on its own)';
  END IF;
  SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
  WHERE c.conname = 'payment_intents_purpose_check' AND c.conrelid = 'public.payment_intents'::regclass;
  IF def IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT v) INTO vals FROM (
    SELECT (regexp_matches(def, '''([A-Z_]+)''', 'g'))[1] AS v
  ) s WHERE v NOT IN ('WALLET_TOPUP', 'SHOP_WALLET_TOPUP');
  EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
  EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
COMMIT;
