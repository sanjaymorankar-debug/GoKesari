-- Franchise dealer module, Pune PMR area booking (owner brief 20-Nov-2026 22.50 IST; docs/franchise/README.md).
-- New tables only, plus three widened checks that keep every existing value: ledger entry types
-- ONE_TIME_FRANCHISE / RECURRING_BASE / RECURRING_BONUS, payment-intent purpose FRANCHISE_FEE, and four
-- nullable link columns on the ledger. Nothing is bookable until an admin approves a zone boundary and
-- switches booking on (franchise config `bookingOpen`). Rollback: scripts/rollback-0157.sql
CREATE TABLE IF NOT EXISTS "franchise_regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_clusters" (
	"code" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL REFERENCES "franchise_regions"("code") ON DELETE restrict,
	"name" text NOT NULL,
	"sort_order" smallint NOT NULL
);
--> statement-breakpoint
-- A bookable area. The owner of a slot lives on franchise_allocations, never here.
CREATE TABLE IF NOT EXISTS "franchise_zones" (
	"zone_id" text PRIMARY KEY NOT NULL,
	"region_code" text NOT NULL REFERENCES "franchise_regions"("code") ON DELETE restrict,
	"cluster_code" text NOT NULL REFERENCES "franchise_clusters"("code") ON DELETE restrict,
	"name" text NOT NULL,
	"commercial_profile" text NOT NULL,
	"origin" text NOT NULL,
	"split_from_zone" text,
	"parent_zone_id" text REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"status" text DEFAULT 'BOUNDARY_PENDING' NOT NULL,
	"max_owners" smallint DEFAULT 2 NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"sort_key" integer NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zones_id" CHECK ("zone_id" ~ '^[0-9]{1,3}[A-Z]?(-[0-9]{1,2})?$|^T-[A-Z0-9]{1,8}$'),
	CONSTRAINT "franchise_zones_origin" CHECK ("origin" IN ('ORIGINAL', 'SPLIT', 'SUB_ZONE', 'TEST')),
	CONSTRAINT "franchise_zones_status" CHECK ("status" IN ('BOUNDARY_PENDING', 'NEEDS_SPLIT', 'BOOKABLE', 'PAUSED', 'RETIRED')),
	CONSTRAINT "franchise_zones_max_owners" CHECK ("max_owners" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_zones_cluster_idx" ON "franchise_zones" ("cluster_code", "sort_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_zone_pins" (
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"pincode" text NOT NULL,
	CONSTRAINT "franchise_zone_pins_pk" PRIMARY KEY ("zone_id", "pincode"),
	CONSTRAINT "franchise_zone_pins_pincode" CHECK ("pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_zone_pins_pincode_idx" ON "franchise_zone_pins" ("pincode");
--> statement-breakpoint
-- The estimate inputs (shops, GMV per shop); monthly and annual area business are computed by the app.
CREATE TABLE IF NOT EXISTS "franchise_zone_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"est_shop_count" integer NOT NULL,
	"gmv_per_shop_lakh" numeric(8, 2) NOT NULL,
	"as_of" date NOT NULL,
	"source" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zone_estimates_shops" CHECK ("est_shop_count" >= 0),
	CONSTRAINT "franchise_zone_estimates_gmv" CHECK ("gmv_per_shop_lakh" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_estimates_current_unique" ON "franchise_zone_estimates" ("zone_id") WHERE "is_current";
--> statement-breakpoint
-- A zone's boundary: reference point plus a polygon ([[lat, lng], ...]) or a circle. One APPROVED row per zone.
CREATE TABLE IF NOT EXISTS "franchise_zone_boundaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"version" integer NOT NULL,
	"ref_lat" numeric(9, 6),
	"ref_lng" numeric(9, 6),
	"ref_label" text,
	"ref_source" text DEFAULT 'ADMIN' NOT NULL,
	"ref_needs_review" boolean DEFAULT false NOT NULL,
	"shape" text DEFAULT 'NONE' NOT NULL,
	"polygon" jsonb,
	"radius_m" integer,
	"max_distance_m" integer,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"note" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zone_boundaries_ref_source" CHECK ("ref_source" IN ('AUTO_GEOCODE', 'ADMIN', 'GEOJSON')),
	CONSTRAINT "franchise_zone_boundaries_shape" CHECK ("shape" IN ('NONE', 'POLYGON', 'CIRCLE')),
	CONSTRAINT "franchise_zone_boundaries_shape_data" CHECK (("shape" <> 'POLYGON' OR "polygon" IS NOT NULL) AND ("shape" <> 'CIRCLE' OR ("radius_m" > 0 AND "ref_lat" IS NOT NULL AND "ref_lng" IS NOT NULL))),
	CONSTRAINT "franchise_zone_boundaries_status" CHECK ("status" IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
	CONSTRAINT "franchise_zone_boundaries_approved" CHECK ("status" <> 'APPROVED' OR ("shape" <> 'NONE' AND "approved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_boundaries_version_unique" ON "franchise_zone_boundaries" ("zone_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_boundaries_approved_unique" ON "franchise_zone_boundaries" ("zone_id") WHERE "status" = 'APPROVED';
--> statement-breakpoint
-- Commercial configuration, versioned with an effective time; a booking / commission uses the version in force.
CREATE TABLE IF NOT EXISTS "franchise_config_versions" (
	"version" integer PRIMARY KEY NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"config" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"text_sha256" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_agreement_acceptances_owner_idx" ON "franchise_agreement_acceptances" ("owner_dealer_id", "accepted_at");
--> statement-breakpoint
-- A cart / order: one or more zones (NEW) or one allocation's renewal (RENEWAL), paid together.
CREATE TABLE IF NOT EXISTS "franchise_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"kind" text DEFAULT 'NEW' NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"area_count" integer NOT NULL,
	"fee_per_area_paise" bigint NOT NULL,
	"base_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"gst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"config_version" integer NOT NULL REFERENCES "franchise_config_versions"("version") ON DELETE restrict,
	"launch_offer" boolean DEFAULT false NOT NULL,
	"agreement_acceptance_id" uuid REFERENCES "franchise_agreement_acceptances"("id") ON DELETE restrict,
	"renewal_allocation_id" uuid,
	"payment_intent_id" uuid,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"failure_reason" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_bookings_kind" CHECK ("kind" IN ('NEW', 'RENEWAL')),
	CONSTRAINT "franchise_bookings_status" CHECK ("status" IN ('RESERVED', 'PAYMENT_PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "franchise_bookings_amounts" CHECK ("area_count" > 0 AND "fee_per_area_paise" > 0 AND "base_paise" = "fee_per_area_paise" * "area_count" AND "gst_paise" >= 0 AND "total_paise" = "base_paise" + "gst_paise")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_bookings_owner_idx" ON "franchise_bookings" ("owner_dealer_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_bookings_intent_unique" ON "franchise_bookings" ("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;
--> statement-breakpoint
-- One owner's slot in one zone. The capacity rule lives in the two partial unique indexes below: a zone has
-- slots 1 and 2 only, each held by one occupying allocation, and one owner never holds both.
CREATE TABLE IF NOT EXISTS "franchise_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"slot_no" smallint NOT NULL,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"booking_id" uuid NOT NULL REFERENCES "franchise_bookings"("id") ON DELETE restrict,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"tail_end_at" timestamp with time zone,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"fee_paise" bigint NOT NULL,
	"config_version" integer NOT NULL REFERENCES "franchise_config_versions"("version") ON DELETE restrict,
	"launch_offer" boolean DEFAULT false NOT NULL,
	"launch_seq" integer,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_allocations_slot" CHECK ("slot_no" IN (1, 2)),
	CONSTRAINT "franchise_allocations_status" CHECK ("status" IN ('RESERVED', 'PAYMENT_PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED', 'CANCELLED', 'RESERVATION_EXPIRED', 'PAYMENT_FAILED')),
	CONSTRAINT "franchise_allocations_active_dates" CHECK ("status" NOT IN ('ACTIVE', 'SUSPENDED', 'EXPIRED') OR ("activated_at" IS NOT NULL AND "expires_at" > "activated_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_allocations_slot_unique" ON "franchise_allocations" ("zone_id", "slot_no") WHERE "status" IN ('RESERVED', 'PAYMENT_PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_allocations_owner_unique" ON "franchise_allocations" ("zone_id", "owner_dealer_id") WHERE "status" IN ('RESERVED', 'PAYMENT_PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_allocations_owner_idx" ON "franchise_allocations" ("owner_dealer_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_allocations_expiry_idx" ON "franchise_allocations" ("status", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_allocations_booking_idx" ON "franchise_allocations" ("booking_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_allocation_renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid NOT NULL REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"booking_id" uuid NOT NULL REFERENCES "franchise_bookings"("id") ON DELETE restrict,
	"previous_expires_at" timestamp with time zone NOT NULL,
	"new_expires_at" timestamp with time zone NOT NULL,
	"fee_paise" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_allocation_renewals_dates" CHECK ("new_expires_at" > "previous_expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_allocation_renewals_booking_unique" ON "franchise_allocation_renewals" ("booking_id");
--> statement-breakpoint
-- Launch offer: the moment it closed (counted on verified payment time) — once closed it stays closed.
CREATE TABLE IF NOT EXISTS "franchise_campaigns" (
	"code" text PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"owners_at_close" integer,
	"areas_at_close" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A dealer code (GKF-xxxxxx): one per dealer per booked area (allocation_id; brief 21-Nov-2026 §1.4), or a team
-- member's tracking code (member_id, allocation_id null) that counts for the owner's areas.
CREATE TABLE IF NOT EXISTS "franchise_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL REFERENCES "referral_codes"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE restrict,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_codes_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'RETIRED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_codes_referral_unique" ON "franchise_codes" ("referral_code_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_codes_allocation_unique" ON "franchise_codes" ("allocation_id") WHERE "allocation_id" IS NOT NULL AND "member_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_codes_member_unique" ON "franchise_codes" ("member_id") WHERE "member_id" IS NOT NULL AND "status" = 'ACTIVE';
--> statement-breakpoint
-- A shop registered with a franchise code: which owner, allocation and zone it earns for.
CREATE TABLE IF NOT EXISTS "franchise_shop_attributions" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"allocation_id" uuid NOT NULL REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"franchise_code_id" uuid NOT NULL REFERENCES "franchise_codes"("id") ON DELETE restrict,
	"member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE restrict,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"hold_reason" text,
	"override_reason" text,
	"override_by" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_shop_attributions_status" CHECK ("status" IN ('ACTIVE', 'HELD', 'REVERSED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_shop_attributions_owner_idx" ON "franchise_shop_attributions" ("owner_dealer_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_shop_attributions_allocation_idx" ON "franchise_shop_attributions" ("allocation_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_shop_attribution_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_shop_attribution_history_shop_idx" ON "franchise_shop_attribution_history" ("shop_id", "created_at");
--> statement-breakpoint
-- The monthly bonus calculation per dealer code (brief 21-Nov-2026 §3, §5): opening shops (frozen at the first run),
-- baseline, new shops, business, points, bonus, rate, rating and the payout lines. DRAFT until the payout is locked
-- on the 5th; after that it never changes and later corrections go to the next month's adjustments.
CREATE TABLE IF NOT EXISTS "franchise_monthly_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid NOT NULL REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"zone_id" text NOT NULL,
	"code" text,
	"month" text NOT NULL,
	"config_version" integer NOT NULL,
	"opening_shop_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opening_shops" integer NOT NULL,
	"baseline_paise" bigint NOT NULL,
	"new_shops" integer NOT NULL,
	"actual_business_paise" bigint NOT NULL,
	"all_business_paise" bigint NOT NULL,
	"reg_base_pts" integer NOT NULL,
	"biz_base_pts" integer NOT NULL,
	"total_base_pts" integer NOT NULL,
	"main_pts" numeric(10, 2) NOT NULL,
	"bonus_bp" integer NOT NULL,
	"commission_rate_bp" integer NOT NULL,
	"rating" numeric(4, 2) NOT NULL,
	"bonus_eligible" boolean DEFAULT true NOT NULL,
	"onboarding_paise" bigint NOT NULL,
	"recurring_paise" bigint NOT NULL,
	"adjustments_paise" bigint DEFAULT 0 NOT NULL,
	"total_payout_paise" bigint NOT NULL,
	"next_opening_shops" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"statement_emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_monthly_snapshots_status" CHECK ("status" IN ('DRAFT', 'LOCKED')),
	CONSTRAINT "franchise_monthly_snapshots_month" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_monthly_snapshots_unique" ON "franchise_monthly_snapshots" ("allocation_id", "month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_monthly_snapshots_owner_idx" ON "franchise_monthly_snapshots" ("owner_dealer_id", "month");
--> statement-breakpoint
-- Every expiry reminder / alert / digest sent (recipient, channel, time) — also the guard against sending twice.
CREATE TABLE IF NOT EXISTS "franchise_notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"kind" text NOT NULL,
	"due_on" date NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_notification_log_channel" CHECK ("channel" IN ('EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'IN_APP', 'ADMIN_ALERT')),
	CONSTRAINT "franchise_notification_log_status" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED', 'SKIPPED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_notification_log_once" ON "franchise_notification_log" (coalesce("allocation_id"::text, '-'), "kind", "due_on", "channel", "recipient");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "franchise_compliance_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"level" text NOT NULL,
	"note" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_compliance_violations_level" CHECK ("level" IN ('WARNING', 'RECORDED', 'SUSPENSION', 'TERMINATION'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_compliance_violations_owner_idx" ON "franchise_compliance_violations" ("owner_dealer_id", "created_at");
--> statement-breakpoint
-- One row per monthly run (rating + recurring commission for a month): the guard that it ran, and its summary.
CREATE TABLE IF NOT EXISTS "franchise_calc_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	CONSTRAINT "franchise_calc_runs_kind" CHECK ("kind" IN ('MONTHLY')),
	CONSTRAINT "franchise_calc_runs_status" CHECK ("status" IN ('RUNNING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
-- Ledger: link columns (all nullable) and the three franchise entry types, keeping every existing type.
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "franchise_allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "franchise_zone_id" text;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "config_version" integer;
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD COLUMN IF NOT EXISTS "calc_run_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_commission_ledger_franchise_idx" ON "dealer_commission_ledger" ("franchise_allocation_id") WHERE "franchise_allocation_id" IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
	def text;
	vals text[];
BEGIN
	SELECT pg_get_constraintdef(c.oid) INTO def FROM pg_constraint c
	WHERE c.conname = 'dealer_commission_ledger_entry_type' AND c.conrelid = 'public.dealer_commission_ledger'::regclass;
	IF def IS NULL THEN
		RETURN;
	END IF;
	SELECT array_agg(DISTINCT v) INTO vals FROM (
		SELECT (regexp_matches(def, '''([A-Z0-9_]+)''', 'g'))[1] AS v
		UNION SELECT unnest(ARRAY['ONE_TIME_FRANCHISE', 'RECURRING_BASE', 'RECURRING_BONUS'])
	) s;
	EXECUTE 'ALTER TABLE public.dealer_commission_ledger DROP CONSTRAINT dealer_commission_ledger_entry_type';
	EXECUTE format('ALTER TABLE public.dealer_commission_ledger ADD CONSTRAINT dealer_commission_ledger_entry_type CHECK ("entry_type" IN (%s))',
		(SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
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
		UNION SELECT unnest(ARRAY['FRANCHISE_FEE'])
	) s;
	EXECUTE 'ALTER TABLE public.payment_intents DROP CONSTRAINT payment_intents_purpose_check';
	EXECUTE format('ALTER TABLE public.payment_intents ADD CONSTRAINT payment_intents_purpose_check CHECK ("purpose" IN (%s))',
		(SELECT string_agg(quote_literal(v), ', ' ORDER BY v) FROM unnest(vals) v));
END $$;
--> statement-breakpoint
INSERT INTO "franchise_regions" ("code", "name", "state") VALUES ('PMR', 'Pune Metropolitan Region', 'Maharashtra') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_campaigns" ("code") VALUES ('LAUNCH') ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The Pune PMR territory master: 7 macro clusters, 91 zones, their PIN codes and estimates (docs/franchise/pune_pmr_91_zones_seed.csv).
INSERT INTO "franchise_clusters" ("code", "region_code", "name", "sort_order") VALUES
	('C1', 'PMR', 'Central Core & Peth Areas', 1),
	('C2', 'PMR', 'East Corridor (Nagar Rd & Hadapsar)', 2),
	('C3', 'PMR', 'South-East & South Corridor', 3),
	('C4', 'PMR', 'West Corridor (Kothrud & Baner)', 4),
	('C5', 'PMR', 'North-West IT & Residential Belt', 5),
	('C6', 'PMR', 'PCMC Core & Industrial Belt', 6),
	('C7', 'PMR', 'Outer PMR Growth Corridors', 7)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zones" ("zone_id", "region_code", "cluster_code", "name", "commercial_profile", "origin", "split_from_zone", "sort_key") VALUES
	('1A', 'PMR', 'C1', 'Mandai & Tulsibaug Market', 'High-Footfall Retail & General Trade', 'SPLIT', '1', 101),
	('1B', 'PMR', 'C1', 'Budhwar Peth (Electronics & Book Market)', 'Electronics, Optics & Wholesale', 'SPLIT', '1', 102),
	('2A', 'PMR', 'C1', 'Raviwar Peth (Kapad Ganj & Wholesale Cloth)', 'Textiles & Apparel Wholesale', 'SPLIT', '2', 201),
	('2B', 'PMR', 'C1', 'Bohri Ali & Ganesh Peth (Hardware & Electricals)', 'Hardware, Paint & Electrical Wholesale', 'SPLIT', '2', 202),
	('2C', 'PMR', 'C1', 'Raviwar Peth East & Phadke Haud Belt', 'General Wholesale & Packaging', 'SPLIT', '2', 203),
	('3A', 'PMR', 'C1', 'Shukrawar Peth (Mandai South & Bajirao Rd)', 'Dense Retail & Hardware Trade', 'SPLIT', '3', 301),
	('3B', 'PMR', 'C1', 'Swargate North, Jedhe Chowk & Ghorpade Peth', 'Transit Hub & Wholesale Fringe', 'SPLIT', '3', 302),
	('4', 'PMR', 'C1', 'Sadashiv Peth & Tilak Road', 'Traditional Retail & Commercial', 'ORIGINAL', NULL, 400),
	('5A', 'PMR', 'C1', 'Laxmi Road (Belbaug Chowk to Umbrya Ganpati)', 'Jewelry & Bridal High-Street', 'SPLIT', '5', 501),
	('5B', 'PMR', 'C1', 'Narayan Peth & Kelkar Road', 'Apparel, Books & Commercial Retail', 'SPLIT', '5', 502),
	('6', 'PMR', 'C1', 'Kasba Peth & Somwar Peth', 'Old City Mixed Retail', 'ORIGINAL', NULL, 600),
	('7A', 'PMR', 'C1', 'Nana Peth & Quarter Gate (Auto Spare Parts Hub)', 'Automotive & Machinery Wholesale', 'SPLIT', '7', 701),
	('7B', 'PMR', 'C1', 'Rasta Peth & Bhavani Peth North', 'Electricals, Timber & Retail', 'SPLIT', '7', 702),
	('8A', 'PMR', 'C1', 'Camp – MG Road & Aurora Towers Belt', 'Premium High-Street & Apparel', 'SPLIT', '8', 801),
	('8B', 'PMR', 'C1', 'East Street, Sachapir Street & Center Street', 'F&B, Footwear & Heritage Retail', 'SPLIT', '8', 802),
	('9A', 'PMR', 'C1', 'JM Road & Deccan Gymkhana', 'Youth High-Street, F&B & Retail', 'SPLIT', '9', 901),
	('9B', 'PMR', 'C1', 'Shivajinagar & Patil Estate Commercial', 'Commercial Offices, Auto & Retail', 'SPLIT', '9', 902),
	('10', 'PMR', 'C1', 'FC Road, Model Colony & Gokhalenagar', 'Student, F&B & Retail Hub', 'ORIGINAL', NULL, 1000),
	('11A', 'PMR', 'C1', 'Gultekdi Market Yard (Wholesale Agri & Grain Block)', 'Agri-Commodity Wholesale', 'SPLIT', '11', 1101),
	('11B', 'PMR', 'C1', 'Gultekdi Fruits, Veg & Cold Storage Hub', 'Perishables & Bulk Wholesale', 'SPLIT', '11', 1102),
	('11C', 'PMR', 'C1', 'Timber Market & Bhavani Peth South', 'Timber, Plywood & Hardware Wholesale', 'SPLIT', '11', 1103),
	('12', 'PMR', 'C1', 'Salisbury Park, Maharshi Nagar & Swargate South', 'Residential & Mid-Tier Retail', 'ORIGINAL', NULL, 1200),
	('13', 'PMR', 'C2', 'Koregaon Park & Bund Garden Road', 'Upscale F&B, Boutiques & Commercial', 'ORIGINAL', NULL, 1300),
	('14', 'PMR', 'C2', 'Kalyani Nagar & Wadgaon Sheri West', 'Affluent Residential & Commercial', 'ORIGINAL', NULL, 1400),
	('15', 'PMR', 'C2', 'Wadgaon Sheri East & Chandan Nagar', 'High-Density Neighborhood Retail', 'ORIGINAL', NULL, 1500),
	('16A', 'PMR', 'C2', 'Viman Nagar – Phoenix Marketcity & Airport Rd', 'Malls, High-Street & Hospitality', 'SPLIT', '16', 1601),
	('16B', 'PMR', 'C2', 'Sakore Nagar, Symbiosis & Datta Mandir Chowk', 'F&B, Student & Neighborhood Retail', 'SPLIT', '16', 1602),
	('17', 'PMR', 'C2', 'Yerwada, Vishrantwadi & Tingre Nagar', 'Mixed Urban & Arterial Retail', 'ORIGINAL', NULL, 1700),
	('18', 'PMR', 'C2', 'Dhanori, Lohegaon & Porwal Road', 'Rapid-Growth Suburban Retail', 'ORIGINAL', NULL, 1800),
	('19A', 'PMR', 'C2', 'Kharadi – EON IT Park & World Trade Center', 'Corporate F&B & Modern Retail', 'SPLIT', '19', 1901),
	('19B', 'PMR', 'C2', 'Tulaja Bhavani Nagar & Chandan Nagar South', 'High-Density Neighborhood Retail', 'SPLIT', '19', 1902),
	('20', 'PMR', 'C2', 'Kharadi South, Mundhwa & Keshav Nagar', 'Emerging Residential & F&B', 'ORIGINAL', NULL, 2000),
	('21', 'PMR', 'C2', 'Wagholi West (Kesnand Phata to Ivy Estate)', 'High-Growth Township Retail', 'ORIGINAL', NULL, 2100),
	('22', 'PMR', 'C2', 'Wagholi East & Bakori / Lonikand Fringe', 'Peri-Urban & Highway Retail', 'ORIGINAL', NULL, 2200),
	('23A', 'PMR', 'C2', 'Hadapsar Gadital & North Solapur Road', 'Suburban Wholesale & Arterial Retail', 'SPLIT', '23', 2301),
	('23B', 'PMR', 'C2', 'Magarpatta City & Amanora Commercial Belt', 'IT Hub, Malls & Modern Retail', 'SPLIT', '23', 2302),
	('24', 'PMR', 'C2', 'Hadapsar South – Manjari, Sade Satra Nali & Bhekrai Nagar', 'Expanding Residential & General Trade', 'ORIGINAL', NULL, 2400),
	('25', 'PMR', 'C3', 'Wanowrie, Fatima Nagar & Ramtekdi', 'Mixed Residential & Industrial Fringe', 'ORIGINAL', NULL, 2500),
	('26', 'PMR', 'C3', 'Kondhwa Khurd & NIBM Road', 'High-Density Retail & Cafes', 'ORIGINAL', NULL, 2600),
	('27', 'PMR', 'C3', 'Kondhwa Budruk, Pisoli & Yewalewadi', 'Suburban General Trade & Hardware', 'ORIGINAL', NULL, 2700),
	('28', 'PMR', 'C3', 'Undri, Mohammedwadi & Handewadi', 'New Residential & Convenience Retail', 'ORIGINAL', NULL, 2800),
	('29', 'PMR', 'C3', 'Bibwewadi & Upper Indira Nagar', 'Dense Middle-Class Retail', 'ORIGINAL', NULL, 2900),
	('30', 'PMR', 'C3', 'Dhankawadi, Balajinagar & Padmavati', 'High-Footfall Arterial Retail', 'ORIGINAL', NULL, 3000),
	('31', 'PMR', 'C3', 'Katraj, Bharati Vidyapeeth & Ambegaon Bk', 'Student, Transit & Highway Retail', 'ORIGINAL', NULL, 3100),
	('32', 'PMR', 'C3', 'Narhe, Dhayari & Vadgaon Budruk', 'Suburban & Small-Industrial Retail', 'ORIGINAL', NULL, 3200),
	('33', 'PMR', 'C3', 'Sinhagad Road – Anand Nagar, Hingne & Manik Baug', 'Established Residential High-Street', 'ORIGINAL', NULL, 3300),
	('34', 'PMR', 'C3', 'Parvati, Dattawadi & Sinhagad Rd North', 'Dense Urban General Trade', 'ORIGINAL', NULL, 3400),
	('35', 'PMR', 'C4', 'Karve Nagar & Cummins College Belt', 'Dense Residential & Student Retail', 'ORIGINAL', NULL, 3500),
	('36A', 'PMR', 'C4', 'Kothrud – Paud Road & MIT Belt', 'Suburban Commercial & Student Retail', 'SPLIT', '36', 3601),
	('36B', 'PMR', 'C4', 'Rambaug Colony, Ideal Colony & Karve Statue', 'Established High-Street Retail', 'SPLIT', '36', 3602),
	('37', 'PMR', 'C4', 'Kothrud – Bhusari Colony, Chandni Chowk & Bavdhan', 'Affluent Suburban & Highway Retail', 'ORIGINAL', NULL, 3700),
	('38', 'PMR', 'C4', 'Warje Malwadi & NDA Road', 'High-Density General Trade', 'ORIGINAL', NULL, 3800),
	('39', 'PMR', 'C4', 'Erandwane, Prabhat Road & Law College Road', 'Upscale Neighborhood & Boutique Retail', 'ORIGINAL', NULL, 3900),
	('40', 'PMR', 'C4', 'Aundh & ITI Road Belt', 'Premium High-Street & F&B', 'ORIGINAL', NULL, 4000),
	('41A', 'PMR', 'C4', 'Baner Road (Sadanand to Pancard Club Rd)', 'IT Corridor & High-Street Retail', 'SPLIT', '41', 4101),
	('41B', 'PMR', 'C4', 'Balewadi High Street & Balewadi Phata', 'Upscale F&B & Commercial Hub', 'SPLIT', '41', 4102),
	('42', 'PMR', 'C4', 'Pashan, Sus & Mahalunge', 'Growing Residential & Tech Fringe', 'ORIGINAL', NULL, 4200),
	('43', 'PMR', 'C5', 'Wakad East & Kaspate Wasti', 'Dense IT-Residential Retail', 'ORIGINAL', NULL, 4300),
	('44', 'PMR', 'C5', 'Wakad West, Tathawade & Punawale', 'Rapid-Growth Township & Highway Retail', 'ORIGINAL', NULL, 4400),
	('45', 'PMR', 'C5', 'Hinjewadi Phase 1 & Phase 2', 'IT Park Support, F&B & Retail', 'ORIGINAL', NULL, 4500),
	('46', 'PMR', 'C5', 'Hinjewadi Phase 3, Maan & Marunji', 'Emerging IT-Residential Fringe', 'ORIGINAL', NULL, 4600),
	('47', 'PMR', 'C5', 'Pimple Saudagar & Rahatani', 'High-Income Suburban High-Street', 'ORIGINAL', NULL, 4700),
	('48', 'PMR', 'C5', 'Pimple Nilakh, Vishal Nagar & Jagtap Dairy', 'Affluent Neighborhood Retail', 'ORIGINAL', NULL, 4800),
	('49', 'PMR', 'C5', 'Pimple Gurav, Sangvi & Dapodi', 'High-Density General Trade', 'ORIGINAL', NULL, 4900),
	('50A', 'PMR', 'C6', 'Pimpri Camp – Main Bazaar & Sai Chowk', 'Mega Wholesale & General Retail', 'SPLIT', '50', 5001),
	('50B', 'PMR', 'C6', 'Shagun Chowk & Pimpri Station Road', 'Apparel, Electronics & High-Street', 'SPLIT', '50', 5002),
	('50C', 'PMR', 'C6', 'Pimpri Cloth Market & Nehru Nagar Fringe', 'Wholesale & Commercial Trade', 'SPLIT', '50', 5003),
	('51', 'PMR', 'C6', 'Pimpri Waghere, Kalewadi & Jyotiba Nagar', 'Dense Residential & General Trade', 'ORIGINAL', NULL, 5100),
	('52', 'PMR', 'C6', 'Kasarwadi, Phugewadi & Nashik Phata', 'Highway, Auto & Industrial Retail', 'ORIGINAL', NULL, 5200),
	('53A', 'PMR', 'C6', 'Bhosari MIDC (Industrial & Engineering Supply)', 'Industrial B2B & Tooling', 'SPLIT', '53', 5301),
	('53B', 'PMR', 'C6', 'Bhosari Gaon & Pune-Nashik Highway West', 'Hardware, Auto & Commercial', 'SPLIT', '53', 5302),
	('54', 'PMR', 'C6', 'Bhosari East, Dighi & Charholi', 'Suburban General Trade', 'ORIGINAL', NULL, 5400),
	('55A', 'PMR', 'C6', 'Chinchwad Station & Empire Estate', 'Commercial, Auto & High-Street', 'SPLIT', '55', 5501),
	('55B', 'PMR', 'C6', 'Morwadi, Ajmera & Pimpri-Chinchwad Link Rd', 'Mixed Commercial & General Trade', 'SPLIT', '55', 5502),
	('56', 'PMR', 'C6', 'Chinchwad Gaon, Walhekarwadi & Bijlinagar', 'Dense Residential Retail', 'ORIGINAL', NULL, 5600),
	('57', 'PMR', 'C6', 'Thergaon & Dange Chowk Belt', 'High-Footfall Suburban Retail', 'ORIGINAL', NULL, 5700),
	('58A', 'PMR', 'C6', 'Nigdi Pradhikaran & Bhakti Shakti', 'Affluent High-Street & Retail', 'SPLIT', '58', 5801),
	('58B', 'PMR', 'C6', 'Akurdi Station, Khandoba Mal & Bijlinagar East', 'Commercial, Student & General Trade', 'SPLIT', '58', 5802),
	('59', 'PMR', 'C6', 'Ravet, Kiwale & Mamurdi', 'New Township & Expressway Retail', 'ORIGINAL', NULL, 5900),
	('60', 'PMR', 'C6', 'Chikhali, Moshi & Spine Road', 'Industrial-Residential Growth Belt', 'ORIGINAL', NULL, 6000),
	('61', 'PMR', 'C6', 'Talawade IT Park & Rupeenagar', 'Semi-Urban & Industrial Fringe', 'ORIGINAL', NULL, 6100),
	('62', 'PMR', 'C6', 'Dehu Road & Dehu Gaon', 'Cantonment, Highway & Pilgrim Retail', 'ORIGINAL', NULL, 6200),
	('63A', 'PMR', 'C7', 'Chakan Town & Talegaon Chowk Market', 'Town Market & Agri-Retail', 'SPLIT', '63', 6301),
	('63B', 'PMR', 'C7', 'Chakan MIDC Phase 1 & 2 (Mahalunge-Kharabwadi)', 'Auto-Industrial Supply & Highway Retail', 'SPLIT', '63', 6302),
	('64', 'PMR', 'C7', 'Alandi, Markal & Kelgaon', 'Pilgrim Town & Industrial Fringe', 'ORIGINAL', NULL, 6400),
	('65', 'PMR', 'C7', 'Talegaon Dabhade & Vadgaon Maval', 'Satellite Town & Highway Market', 'ORIGINAL', NULL, 6500),
	('66', 'PMR', 'C7', 'Lonavala & Karla-Kamshet Corridor', 'Tourism, F&B & Highway Retail', 'ORIGINAL', NULL, 6600),
	('67', 'PMR', 'C7', 'Pirangut, Bhugaon & Mulshi Corridor', 'Industrial & Peri-Urban Corridor', 'ORIGINAL', NULL, 6700),
	('68', 'PMR', 'C7', 'Khed Shivapur, Nasrapur & Velhe Belt', 'NH-48 Highway & Rural Market Hub', 'ORIGINAL', NULL, 6800),
	('69', 'PMR', 'C7', 'Saswad, Dive Ghat & Jejuri Corridor', 'Taluka Market & Pilgrim Corridor', 'ORIGINAL', NULL, 6900),
	('70', 'PMR', 'C7', 'Loni Kalbhor, Uruli Kanchan & Yavat Corridor', 'Solapur Highway & Agri-Trade Belt', 'ORIGINAL', NULL, 7000)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zone_pins" ("zone_id", "pincode") VALUES
	('1A', '411002'),
	('1B', '411002'),
	('2A', '411002'),
	('2B', '411002'),
	('2C', '411002'),
	('3A', '411002'),
	('3B', '411002'),
	('3B', '411042'),
	('4', '411030'),
	('5A', '411030'),
	('5B', '411030'),
	('6', '411011'),
	('7A', '411002'),
	('7B', '411011'),
	('7B', '411042'),
	('8A', '411001'),
	('8B', '411001'),
	('9A', '411004'),
	('9B', '411005'),
	('10', '411016'),
	('11A', '411037'),
	('11B', '411037'),
	('11C', '411042'),
	('12', '411037'),
	('13', '411001'),
	('14', '411014'),
	('15', '411014'),
	('16A', '411014'),
	('16B', '411014'),
	('17', '411006'),
	('17', '411015'),
	('18', '411015'),
	('18', '411047'),
	('19A', '411014'),
	('19B', '411014'),
	('20', '411036'),
	('21', '412207'),
	('22', '412207'),
	('23A', '411028'),
	('23B', '411028'),
	('24', '411028'),
	('24', '412307'),
	('25', '411013'),
	('25', '411040'),
	('26', '411048'),
	('27', '411048'),
	('28', '411060'),
	('29', '411037'),
	('30', '411043'),
	('31', '411046'),
	('32', '411041'),
	('33', '411051'),
	('34', '411009'),
	('34', '411030'),
	('35', '411052'),
	('36A', '411038'),
	('36B', '411038'),
	('37', '411038'),
	('37', '411021'),
	('38', '411058'),
	('39', '411004'),
	('40', '411007'),
	('41A', '411045'),
	('41B', '411045'),
	('42', '411021'),
	('42', '411045'),
	('43', '411057'),
	('44', '411057'),
	('44', '411033'),
	('45', '411057'),
	('46', '411057'),
	('47', '411027'),
	('47', '411017'),
	('48', '411027'),
	('49', '411061'),
	('49', '411027'),
	('49', '411012'),
	('50A', '411017'),
	('50B', '411017'),
	('50C', '411017'),
	('51', '411017'),
	('52', '411034'),
	('53A', '411026'),
	('53B', '411026'),
	('54', '411039'),
	('54', '411015'),
	('55A', '411019'),
	('55B', '411018'),
	('55B', '411019'),
	('56', '411033'),
	('57', '411033'),
	('58A', '411044'),
	('58B', '411035'),
	('59', '412101'),
	('60', '412105'),
	('60', '411062'),
	('61', '411062'),
	('62', '412101'),
	('62', '412109'),
	('63A', '410501'),
	('63B', '410501'),
	('64', '412105'),
	('65', '410506'),
	('65', '412106'),
	('66', '410401'),
	('66', '410405'),
	('67', '412115'),
	('68', '412205'),
	('69', '412301'),
	('69', '412303'),
	('70', '412201'),
	('70', '412202')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zone_estimates" ("zone_id", "est_shop_count", "gmv_per_shop_lakh", "as_of", "source")
SELECT v.zone_id, v.shops, v.gmv, DATE '2026-11-01', 'Pune_PMR_Restructured_Zones_Max_5K_Cr.xlsx (owner, Nov 2026)'
FROM (VALUES
	('1A', 2300, 14.5),
	('1B', 2200, 13.5),
	('2A', 1600, 19),
	('2B', 1600, 18),
	('2C', 1600, 17),
	('3A', 2100, 11.5),
	('3B', 2100, 10.5),
	('4', 4000, 9.5),
	('5A', 2200, 16),
	('5B', 2200, 14),
	('6', 3600, 7.5),
	('7A', 2300, 16.5),
	('7B', 2300, 15.5),
	('8A', 1900, 15),
	('8B', 1900, 14),
	('9A', 2100, 14),
	('9B', 2000, 13),
	('10', 3500, 1E+1),
	('11A', 1600, 24),
	('11B', 1600, 22),
	('11C', 1500, 19.8),
	('12', 3200, 8),
	('13', 3000, 12.5),
	('14', 3400, 11.5),
	('15', 3800, 8.5),
	('16A', 2000, 13.5),
	('16B', 1900, 12.5),
	('17', 4100, 9),
	('18', 3300, 7),
	('19A', 1900, 12.5),
	('19B', 1800, 11.5),
	('20', 3400, 8.5),
	('21', 3500, 7.5),
	('22', 2600, 5.5),
	('23A', 2300, 13.5),
	('23B', 2200, 13.5),
	('24', 3600, 7.5),
	('25', 3700, 9),
	('26', 3900, 9.5),
	('27', 3200, 6.5),
	('28', 3100, 7),
	('29', 3600, 8),
	('30', 4000, 9),
	('31', 3800, 8.5),
	('32', 3500, 7),
	('33', 3700, 9.5),
	('34', 3400, 7.5),
	('35', 3600, 8.5),
	('36A', 2100, 11),
	('36B', 2000, 11),
	('37', 3500, 9.5),
	('38', 3700, 8),
	('39', 2900, 9.5),
	('40', 3300, 11.5),
	('41A', 1900, 13),
	('41B', 1900, 13),
	('42', 2800, 6.5),
	('43', 3900, 10.5),
	('44', 3600, 8.5),
	('45', 3400, 1E+1),
	('46', 2500, 6),
	('47', 3800, 10.5),
	('48', 3100, 8.5),
	('49', 4000, 8.5),
	('50A', 1700, 18.5),
	('50B', 1600, 17.5),
	('50C', 1600, 16.4),
	('51', 4100, 9),
	('52', 3300, 8.5),
	('53A', 2200, 15.5),
	('53B', 2200, 13.5),
	('54', 3600, 7.5),
	('55A', 2000, 11.5),
	('55B', 1900, 10.5),
	('56', 3700, 8.5),
	('57', 3800, 9),
	('58A', 2100, 11.5),
	('58B', 2100, 11.5),
	('59', 2900, 6.5),
	('60', 3500, 8),
	('61', 2800, 6),
	('62', 2700, 6),
	('63A', 1900, 11),
	('63B', 1900, 11),
	('64', 2400, 5),
	('65', 3100, 7),
	('66', 2900, 8.5),
	('67', 2300, 5),
	('68', 2200, 4.5),
	('69', 2500, 5.5),
	('70', 2800, 6)
) AS v(zone_id, shops, gmv)
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_estimates" e WHERE e.zone_id = v.zone_id AND e.is_current);
