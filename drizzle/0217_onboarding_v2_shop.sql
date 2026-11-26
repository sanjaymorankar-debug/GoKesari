-- Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11). Flag `onboarding_v2`.
--
-- * payment_intents: new purpose SHOP_REGISTRATION_DRAFT_FEE — the v2 registration fee is paid on the
--   registration draft (the shop row does not exist yet); reference_id is the draft id.
-- * registration_licence_files: a licence file uploaded or scanned during registration, encrypted, before
--   the shop exists (operators open it from Admin → Shop documents → Registration licences).
-- * registration_licence_entries: who decided a PENDING_OPERATOR entry and when.
--
-- The purpose check is re-added NOT VALID: new rows are checked at once, existing rows (all valid) are not
-- re-scanned under the ACCESS EXCLUSIVE lock, so checkouts and captures are not held up during the deploy.
--
-- Additive and safe to re-run. Nothing is dropped. Rollback: scripts/rollback-0217-onboarding-v2-shop.sql.
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
    UNION SELECT 'SHOP_REGISTRATION_DRAFT_FEE'
  ) s;
  EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
  EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registration_licence_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "licence_key" text NOT NULL,
  "source" text NOT NULL DEFAULT 'FILE',
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "sha256" text NOT NULL,
  "data_encrypted" bytea NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "registration_licence_files_source" CHECK ("source" IN ('FILE','CAMERA')),
  CONSTRAINT "registration_licence_files_type" CHECK ("content_type" IN ('application/pdf','image/jpeg','image/png','image/webp'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registration_licence_files_draft_idx" ON "registration_licence_files" ("draft_id", "licence_key");
--> statement-breakpoint
ALTER TABLE "registration_licence_entries" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid;
--> statement-breakpoint
ALTER TABLE "registration_licence_entries" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamptz;
