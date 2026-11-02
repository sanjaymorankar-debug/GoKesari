-- split: both
-- Gap report D4 (02-Nov-2026): the CA role (Chartered Accountant) — dated TDS settings with CA
-- confirmation, certificates, challans and Form 16A, read-only dealer payouts and reports. ADDITIVE
-- ONLY. user_role lives in both databases, so the value is added on both sides, only where the type
-- exists (as 0101 did for DEALER). The value is not used in this file. Rollback: scripts/rollback-0140.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'user_role' AND n.nspname = 'public') THEN
    EXECUTE 'ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS ''CA''';
  END IF;
END $$;
