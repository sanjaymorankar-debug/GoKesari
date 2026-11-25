-- Rider App v2 + Rider Pay Plans (docs/rider-app-v2-2026-11/README.md). Additive only; every new
-- behaviour sits behind a rule that is OFF until an admin turns it on (riderPayPlans, riderJobBoard,
-- riderSlotBooking, riderReferral, riderTiers, riderSos, riderInsurance). With riderPayPlans off,
-- payouts are worked out exactly as before. Rollback: scripts/rollback-0209-rider-app-v2.sql
CREATE TABLE IF NOT EXISTS "rider_pay_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_key" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"scope_type" text DEFAULT 'DEFAULT' NOT NULL,
	"city" text,
	"zone_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"effective_from" timestamp with time zone,
	"base_fee_paise" integer NOT NULL,
	"base_included_m" integer DEFAULT 0 NOT NULL,
	"slabs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_first_mile_m" integer DEFAULT 0 NOT NULL,
	"first_mile_rate_paise" integer DEFAULT 0 NOT NULL,
	"first_mile_cap_paise" integer DEFAULT 0 NOT NULL,
	"free_wait_min" integer DEFAULT 0 NOT NULL,
	"wait_rate_paise" integer DEFAULT 0 NOT NULL,
	"wait_cap_paise" integer DEFAULT 0 NOT NULL,
	"extra_drop_fee_paise" integer DEFAULT 0 NOT NULL,
	"long_distance_m" integer,
	"long_distance_bonus_paise" integer DEFAULT 0 NOT NULL,
	"min_guarantee_paise" integer DEFAULT 0 NOT NULL,
	"max_per_order_paise" integer,
	"reroute_tolerance_pct" integer DEFAULT 15 NOT NULL,
	"note" text,
	"simulation" jsonb,
	"simulated_at" timestamp with time zone,
	"created_by" uuid,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_pay_plans_scope_check" CHECK ("scope_type" IN ('DEFAULT', 'CITY', 'ZONE')),
	CONSTRAINT "rider_pay_plans_status_check" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "rider_pay_plans_amounts_check" CHECK (
		"base_fee_paise" >= 0 AND "base_included_m" >= 0 AND "free_first_mile_m" >= 0 AND "first_mile_rate_paise" >= 0
		AND "first_mile_cap_paise" >= 0 AND "free_wait_min" >= 0 AND "wait_rate_paise" >= 0 AND "wait_cap_paise" >= 0
		AND "extra_drop_fee_paise" >= 0 AND "long_distance_bonus_paise" >= 0 AND "min_guarantee_paise" >= 0
		AND ("max_per_order_paise" IS NULL OR "max_per_order_paise" >= "min_guarantee_paise")
		AND "reroute_tolerance_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_pay_plans_key_version_unique" ON "rider_pay_plans" ("plan_key", "version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_pay_plans_status_idx" ON "rider_pay_plans" ("status", "scope_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_surges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city" text,
	"zone_id" uuid,
	"multiplier_bp" integer DEFAULT 10000 NOT NULL,
	"flat_paise" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_surges_reason_check" CHECK ("reason" IN ('RAIN', 'FESTIVAL', 'EVENT', 'OTHER')),
	CONSTRAINT "rider_surges_values_check" CHECK ("multiplier_bp" BETWEEN 10000 AND 30000 AND "flat_paise" >= 0 AND "ends_at" > "starts_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_surges_window_idx" ON "rider_surges" ("ends_at", "starts_at");
--> statement-breakpoint
ALTER TABLE "rider_earning_slots" ADD COLUMN IF NOT EXISTS "surge_multiplier_bp" integer;
--> statement-breakpoint
ALTER TABLE "rider_earning_slots" ADD COLUMN IF NOT EXISTS "bookable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "rider_earning_slots" ADD COLUMN IF NOT EXISTS "booking_capacity" integer;
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "quote_paise" integer;
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "quote_breakdown" jsonb;
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "pay_plan_id" uuid;
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "quoted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN IF NOT EXISTS "reject_reason_code" text;
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN IF NOT EXISTS "quote_paise" integer;
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN IF NOT EXISTS "pay_plan_id" uuid;
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN IF NOT EXISTS "plan_breakdown" jsonb;
--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "referral_code" text;
--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN IF NOT EXISTS "referred_by_partner_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delivery_partners_referral_code_unique" ON "delivery_partners" ("referral_code") WHERE "referral_code" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_slot_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
	"slot_id" uuid NOT NULL REFERENCES "rider_earning_slots"("id") ON DELETE CASCADE,
	"slot_date" date NOT NULL,
	"status" text DEFAULT 'BOOKED' NOT NULL,
	"reminded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_slot_bookings_status_check" CHECK ("status" IN ('BOOKED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_slot_bookings_unique" ON "rider_slot_bookings" ("delivery_partner_id", "slot_id", "slot_date") WHERE "status" = 'BOOKED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_slot_bookings_date_idx" ON "rider_slot_bookings" ("slot_date", "slot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
	"referred_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"deliveries_required" integer NOT NULL,
	"within_days" integer NOT NULL,
	"reward_paise" integer NOT NULL,
	"qualified_at" timestamp with time zone,
	"paid_adjustment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_referrals_status_check" CHECK ("status" IN ('PENDING', 'QUALIFIED', 'EXPIRED')),
	CONSTRAINT "rider_referrals_not_self" CHECK ("referrer_partner_id" <> "referred_partner_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_referrals_referred_unique" ON "rider_referrals" ("referred_partner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_referrals_referrer_idx" ON "rider_referrals" ("referrer_partner_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_insurance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"insurer" text NOT NULL,
	"policy_number" text NOT NULL,
	"health_cover_paise" bigint DEFAULT 0 NOT NULL,
	"accident_cover_paise" bigint DEFAULT 0 NOT NULL,
	"opd_cover_paise" bigint DEFAULT 0 NOT NULL,
	"min_deliveries" integer DEFAULT 1 NOT NULL,
	"lookback_days" integer DEFAULT 30 NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"hospitals_url" text,
	"hospitals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claim_help" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_insurance_dates_check" CHECK ("valid_to" >= "valid_from")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_nominees" (
	"delivery_partner_id" uuid PRIMARY KEY NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"relation" text NOT NULL,
	"mobile" text,
	"date_of_birth" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rider_sos_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL REFERENCES "delivery_partners"("id") ON DELETE CASCADE,
	"delivery_order_id" uuid,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_m" integer,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_sos_status_check" CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'CLOSED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_sos_events_status_idx" ON "rider_sos_events" ("status", "created_at");
--> statement-breakpoint
-- The existing flat rate (delivery_earnings_config) becomes version 1 of the default plan: one
-- slab from 0 km at the same per-km rate, no minimum, no cap. Same payout as today until an admin
-- publishes a new version. Only seeded when there is no plan yet.
INSERT INTO "rider_pay_plans" ("plan_key", "version", "name", "scope_type", "status", "effective_from",
	"base_fee_paise", "base_included_m", "slabs", "note", "published_at")
SELECT gen_random_uuid(), 1, 'Default plan', 'DEFAULT', 'ACTIVE', now(),
	COALESCE(c."base_fee_paise", 2000)::integer, 0,
	jsonb_build_array(jsonb_build_object('fromM', 0, 'toM', NULL, 'ratePaise', COALESCE(c."per_km_fee_paise", 800))),
	'Migrated from the flat base + per-km rate (0201)', now()
FROM (SELECT 1) AS one
LEFT JOIN LATERAL (
	SELECT "base_fee_paise", "per_km_fee_paise" FROM "delivery_earnings_config"
	WHERE "is_active" = true ORDER BY "created_at" DESC LIMIT 1
) AS c ON true
WHERE NOT EXISTS (SELECT 1 FROM "rider_pay_plans");
