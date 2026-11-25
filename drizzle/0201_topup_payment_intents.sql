-- PAY-2 (docs/payments-topups-via-intents-2026-11): wallet top-ups and shop wallet recharges may run
-- through payment intents (rule topupPaymentIntents, off by default). Adds the two purposes to
-- payment_intents_purpose_check. Additive only: no row changes, no new column; existing intents and
-- payments are untouched. Re-runnable (the constraint is rebuilt from what it already allows).
-- Rollback: scripts/rollback-0201-topup-intents.sql
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
    UNION SELECT unnest(ARRAY['WALLET_TOPUP', 'SHOP_WALLET_TOPUP'])
  ) s;
  EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
  EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
