-- Shop registration subscription (owner brief 25-Nov-2026 02.02 IST; docs/shop-registration-subscription-2026-11/).
--
-- The registration fee is a 1-year subscription. The expiry stays in shops.membership_valid_until (D-69 / 0197)
-- — every gate already reads it — and this migration adds what the brief asks for on top:
--
-- * shops.registration_status: UNPAID / ACTIVE / EXPIRING_SOON / GRACE / EXPIRED / EXEMPT, kept current by every
--   payment, admin change and the reminder job (the app recomputes it on read as well).
-- * shops.registration_start_date, renewal_fee_paise (per-shop override, before GST), registration_grace_days
--   (per-shop override), registration_grace_until (grace given by this migration or an admin), registration_
--   reminders_enabled, last_registration_payment_id / _at.
--   The brief's registration_expiry_date is shops.membership_valid_until; registration_fee is registration_fee_paise.
-- * shop_registration_links: payment links an admin / the reminder job created (one ACTIVE per shop).
-- * shop_registration_reminders: every reminder sent (automatic or by staff), once per shop, stage and day.
-- * shop_registration_migration_reports: the counts per status written by this migration (the migration report).
--
-- Existing shops:
-- * fee fully paid, no end date, fee > 0, not exempt: start = first registration-fee payment (else approval / creation),
--   end = start + 12 months, plus a LEGACY period (as 0197) so old payments are not counted again.
-- * fee not paid: UNPAID (nothing else changes — the shop still gets no orders until it pays).
-- * end date already past: GRACE until now() + 7 days (nobody is cut off on day 1).
-- * fee 0 / waived / exempt: no end date, never expires.
--
-- Additive and safe to re-run. Rollback: scripts/rollback-0200.sql.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_status" text NOT NULL DEFAULT 'UNPAID';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "shops" ADD CONSTRAINT "shops_registration_status_check"
    CHECK ("registration_status" IN ('UNPAID', 'ACTIVE', 'EXPIRING_SOON', 'GRACE', 'EXPIRED', 'EXEMPT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_start_date" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "renewal_fee_paise" bigint;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_grace_days" integer;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_grace_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_reminders_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "last_registration_payment_id" uuid;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "last_registration_payment_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_status_at" timestamp with time zone;
--> statement-breakpoint
-- What this migration did to the shop (END_DATE_SET, GRACE_GIVEN or both), for the report and a rollback.
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_backfill" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shops_registration_status_idx" ON "shops" ("registration_status", "membership_valid_until") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_registration_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "payment_intent_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "amount_paise" bigint NOT NULL,
  "link_url" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_by" uuid,
  "created_via" text NOT NULL DEFAULT 'ADMIN',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "sent_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "end_reason" text,
  CONSTRAINT "shop_registration_links_kind" CHECK ("kind" IN ('REGISTRATION', 'RENEWAL')),
  CONSTRAINT "shop_registration_links_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED', 'EXPIRED', 'PAID')),
  CONSTRAINT "shop_registration_links_via" CHECK ("created_via" IN ('ADMIN', 'REMINDER')),
  CONSTRAINT "shop_registration_links_amount" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_registration_links_one_active" ON "shop_registration_links" ("shop_id") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_registration_links_intent_uq" ON "shop_registration_links" ("payment_intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_links_shop_idx" ON "shop_registration_links" ("shop_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_registration_reminders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL REFERENCES "shops"("id"),
  "kind" text NOT NULL,
  "stage" text NOT NULL,
  "due_on" date NOT NULL,
  "channels" text NOT NULL DEFAULT 'IN_APP,PUSH,EMAIL',
  "link_id" uuid,
  "sent_by" uuid,
  "status" text NOT NULL DEFAULT 'SENT',
  "detail" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "shop_registration_reminders_kind" CHECK ("kind" IN ('UNPAID', 'RENEWAL')),
  CONSTRAINT "shop_registration_reminders_status" CHECK ("status" IN ('SENT', 'FAILED', 'SKIPPED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_registration_reminders_once" ON "shop_registration_reminders" ("shop_id", "stage", "due_on") WHERE "sent_by" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_registration_reminders_shop_idx" ON "shop_registration_reminders" ("shop_id", "created_at");
--> statement-breakpoint
-- One row per day the expiry digest went to the CC list (rule shopRegistrationSubscription.ccEmails).
CREATE TABLE IF NOT EXISTS "shop_registration_digests" (
  "day" date PRIMARY KEY,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  "detail" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_registration_migration_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ran_at" timestamp with time zone NOT NULL DEFAULT now(),
  "counts" jsonb NOT NULL,
  "backfilled" integer NOT NULL DEFAULT 0,
  "graced" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
-- Start date of shops that already have an end date: their first registration-fee payment, else end − 12 months.
UPDATE "shops" s SET "registration_start_date" = COALESCE(
  (SELECT MIN(p."paid_at") FROM "shop_payments" p WHERE p."shop_id" = s."id" AND p."payment_type" = 'REGISTRATION_FEE' AND p."amount_paise" > 0),
  s."membership_valid_until" - interval '12 months')
WHERE s."membership_valid_until" IS NOT NULL AND s."registration_start_date" IS NULL;
--> statement-breakpoint
-- Paid shops with no end date (registered before D-69 set one): start = first fee payment, end = + 12 months.
WITH paid AS (
  SELECT s."id",
    COALESCE(
      (SELECT MIN(p."paid_at") FROM "shop_payments" p WHERE p."shop_id" = s."id" AND p."payment_type" = 'REGISTRATION_FEE' AND p."amount_paise" > 0),
      s."approved_at", s."created_at") AS "start"
  FROM "shops" s
  WHERE s."membership_valid_until" IS NULL
    AND s."deleted_at" IS NULL
    AND s."fee_payment_status" = 'PAID'
    AND COALESCE(s."registration_fee_paise", 0) > 0
    AND NOT s."membership_exempt"
)
UPDATE "shops" s SET "membership_valid_until" = paid."start" + interval '12 months', "registration_start_date" = paid."start",
  "registration_backfill" = 'END_DATE_SET'
FROM paid WHERE s."id" = paid."id";
--> statement-breakpoint
-- A LEGACY period for each of them (same rule as 0197), so what they paid is not counted again at renewal.
INSERT INTO "shop_membership_periods" ("shop_id", "kind", "period_start", "period_end", "previous_valid_until", "fee_paise", "shop_payment_id")
SELECT s."id", 'LEGACY',
  LEAST(s."membership_valid_until", COALESCE(s."registration_start_date", s."membership_valid_until")),
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
  SELECT p."id" FROM "shop_payments" p
  WHERE p."shop_id" = s."id" AND p."payment_type" IN ('REGISTRATION_FEE', 'RENEWAL') AND p."amount_paise" > 0
  ORDER BY p."paid_at" DESC, p."created_at" DESC LIMIT 1
) last ON true
WHERE s."membership_valid_until" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "shop_membership_periods" x WHERE x."shop_id" = s."id");
--> statement-breakpoint
-- Last registration / renewal payment of every shop.
UPDATE "shops" s SET "last_registration_payment_id" = last."id", "last_registration_payment_at" = last."paid_at"
FROM (
  SELECT DISTINCT ON (p."shop_id") p."shop_id", p."id", p."paid_at" FROM "shop_payments" p
  WHERE p."payment_type" IN ('REGISTRATION_FEE', 'RENEWAL') AND p."amount_paise" > 0
  ORDER BY p."shop_id", p."paid_at" DESC, p."created_at" DESC
) last
WHERE last."shop_id" = s."id" AND s."last_registration_payment_id" IS NULL;
--> statement-breakpoint
-- End date already past when this runs: GRACE for 7 days from now, never cut off on day 1.
UPDATE "shops" SET "registration_grace_until" = now() + interval '7 days',
  "registration_backfill" = CASE WHEN "registration_backfill" IS NULL THEN 'GRACE_GIVEN' ELSE "registration_backfill" || ',GRACE_GIVEN' END
WHERE "membership_valid_until" IS NOT NULL AND "membership_valid_until" < now()
    AND "registration_grace_until" IS NULL AND "deleted_at" IS NULL AND NOT "membership_exempt"
    AND NOT EXISTS (SELECT 1 FROM "shop_registration_migration_reports");
--> statement-breakpoint
-- First status (the app keeps it current from here on).
UPDATE "shops" SET "registration_status_at" = now(), "registration_status" = CASE
    WHEN "membership_exempt" THEN 'EXEMPT'
    WHEN "membership_valid_until" IS NULL AND "fee_payment_status" IN ('PENDING', 'PARTIALLY_PAID') AND COALESCE("registration_fee_paise", 0) > 0 THEN 'UNPAID'
    WHEN "membership_valid_until" IS NULL THEN 'ACTIVE'
    WHEN "membership_valid_until" > now() + interval '30 days' THEN 'ACTIVE'
    WHEN "membership_valid_until" > now() THEN 'EXPIRING_SOON'
    WHEN "registration_grace_until" > now() OR "membership_valid_until" > now() - interval '7 days' THEN 'GRACE'
    ELSE 'EXPIRED'
  END
WHERE "registration_status_at" IS NULL;
--> statement-breakpoint
-- The migration report: counts per status (live shops — not deleted), once.
INSERT INTO "shop_registration_migration_reports" ("counts", "backfilled", "graced")
SELECT
  jsonb_build_object(
    'UNPAID', COUNT(*) FILTER (WHERE "registration_status" = 'UNPAID'),
    'ACTIVE', COUNT(*) FILTER (WHERE "registration_status" = 'ACTIVE'),
    'ACTIVE_NO_END_DATE', COUNT(*) FILTER (WHERE "registration_status" = 'ACTIVE' AND "membership_valid_until" IS NULL),
    'EXPIRING_SOON', COUNT(*) FILTER (WHERE "registration_status" = 'EXPIRING_SOON'),
    'GRACE', COUNT(*) FILTER (WHERE "registration_status" = 'GRACE'),
    'EXPIRED', COUNT(*) FILTER (WHERE "registration_status" = 'EXPIRED'),
    'EXEMPT', COUNT(*) FILTER (WHERE "registration_status" = 'EXEMPT'),
    'TOTAL', COUNT(*)
  ),
  COUNT(*) FILTER (WHERE "registration_backfill" LIKE '%END_DATE_SET%'),
  COUNT(*) FILTER (WHERE "registration_backfill" LIKE '%GRACE_GIVEN%')
FROM "shops" WHERE "deleted_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "shop_registration_migration_reports");
