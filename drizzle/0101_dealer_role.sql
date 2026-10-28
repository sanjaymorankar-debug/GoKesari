-- split: both
-- Dealer programme (docs/dealer-programme, step 1): the DEALER role for authorised dealers and
-- their salespeople (a salesperson is a DEALER user linked to one dealer; the link arrives with
-- the dealer tables). ADDITIVE ONLY.
-- user_role lives in both databases (users / grants in the core, seller_verification_events in
-- the seller database), so the value is added on both sides, and only where the type exists.
-- The new value is never used in this file (a value added by ALTER TYPE cannot be used in the
-- transaction that adds it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'user_role' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''DEALER''';
  END IF;
END $$;
