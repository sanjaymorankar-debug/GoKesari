-- Shop membership renewal (modules 8 + 9; owner brief 23-Nov-2026; docs/shop-membership-renewal-2026-11/).
--
-- * shops.membership_exempt (+ reason, set_by, set_at): an admin can exempt one shop from the yearly membership
--   (never closed for a lapsed membership, no renewal reminders). Audited (shop.membership_exemption_changed).
-- * payment_intents purpose SHOP_MEMBERSHIP_RENEWAL: the owner pays the yearly renewal online (rule
--   shopMembership.renewalCheckoutEnabled, default off).
-- * shop_membership_periods: one row each time a fully paid fee (registration or renewal) extended a shop's
--   membership — the renewal history, and what a refund or reversal rolls back. A partly paid fee opens no period.
--   Existing shops with an end date get one LEGACY row holding what they had paid so far, so payments recorded
--   before this release are not counted again towards the next renewal.
-- * Renewal reminders are deduplicated on the existing notifications.dedupe_key (no new table).
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0189.sql.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "membership_exempt" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "membership_exempt_reason" text;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "membership_exempt_set_by" uuid;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "membership_exempt_set_at" timestamp with time zone;
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
    UNION SELECT unnest(ARRAY['SHOP_MEMBERSHIP_RENEWAL'])
  ) s;
  EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
  EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
    (SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_membership_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "kind" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "previous_valid_until" timestamp with time zone,
  "fee_paise" bigint NOT NULL DEFAULT 0,
  "base_paise" bigint,
  "gst_rate_bp" integer,
  "gst_paise" bigint,
  "shop_payment_id" uuid REFERENCES "shop_payments"("id"),
  "payment_intent_id" uuid,
  "voided_at" timestamp with time zone,
  "void_reason" text,
  "voided_by_payment_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_membership_periods_kind" CHECK ("kind" IN ('REGISTRATION', 'RENEWAL', 'LEGACY')),
  CONSTRAINT "shop_membership_periods_fee" CHECK ("fee_paise" >= 0),
  CONSTRAINT "shop_membership_periods_dates" CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_membership_periods_shop_idx" ON "shop_membership_periods" ("shop_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_membership_periods_payment_uq" ON "shop_membership_periods" ("shop_payment_id") WHERE "voided_at" IS NULL AND "shop_payment_id" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "shop_membership_periods" ("shop_id", "kind", "period_start", "period_end", "previous_valid_until", "fee_paise", "shop_payment_id")
SELECT s."id", 'LEGACY',
  LEAST(s."membership_valid_until", COALESCE(last."paid_at", s."membership_valid_until")),
  s."membership_valid_until",
  NULL,
  GREATEST(0, COALESCE(net."paise", 0)),
  last."id"
FROM "shops" s
LEFT JOIN LATERAL (
  SELECT SUM(p."amount_paise") AS paise FROM "shop_payments" p
  LEFT JOIN "shop_payments" o ON o."id" = p."reversal_of_id"
  WHERE p."shop_id" = s."id"
    AND (p."payment_type" IN ('REGISTRATION_FEE', 'RENEWAL', 'REFUND')
      OR (p."payment_type" = 'REVERSAL' AND o."payment_type" IN ('REGISTRATION_FEE', 'RENEWAL', 'REFUND')))
) net ON true
LEFT JOIN LATERAL (
  SELECT p."id", p."paid_at" FROM "shop_payments" p
  WHERE p."shop_id" = s."id" AND p."payment_type" IN ('REGISTRATION_FEE', 'RENEWAL') AND p."amount_paise" > 0
  ORDER BY p."paid_at" DESC, p."created_at" DESC LIMIT 1
) last ON true
WHERE s."membership_valid_until" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "shop_membership_periods" x WHERE x."shop_id" = s."id");
