-- Franchise dealer module: Pune franchise zones (owner's final brief 21-Nov-2026 08.06 IST; docs/franchise/README.md).
-- New tables only, plus widened checks that keep every existing value: ledger entry types ONE_TIME_FRANCHISE /
-- RECURRING_BASE / RECURRING_BONUS, payment-intent purpose FRANCHISE_FEE, nullable link columns on the ledger and on
-- dealer_tier_shop_plans (the commission model and case of each shop). A zone is one of the 50 Pune clusters, with
-- an area master (196 areas, 7 unzoned), provisional business index, tier and fee. Nothing is bookable until an
-- admin sets zones Available, publishes final fees (or allows provisional sale) and switches booking on.
-- Rollback: scripts/rollback-0157.sql
CREATE TABLE IF NOT EXISTS "franchise_zone_sets" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zone_sets_code" CHECK ("code" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
-- One franchise zone (a cluster of areas). The owners of its slots live on franchise_allocations, never here.
-- reserved_for_dealer_id has no foreign key on purpose (the service checks the dealer), so reference data never
-- depends on a dealer row.
CREATE TABLE IF NOT EXISTS "franchise_zones" (
	"zone_id" text PRIMARY KEY NOT NULL,
	"zone_set_code" text NOT NULL REFERENCES "franchise_zone_sets"("code") ON DELETE restrict,
	"cluster_no" integer NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"civic_body" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'COMING_SOON' NOT NULL,
	"reserved_for_dealer_id" uuid,
	"reserved_until" timestamp with time zone,
	"max_owners" smallint DEFAULT 2 NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zones_id" CHECK ("zone_id" ~ '^GKZ-[A-Z]{3}-[0-9]{2,3}$|^T-[A-Z0-9]{1,8}$'),
	CONSTRAINT "franchise_zones_status" CHECK ("status" IN ('AVAILABLE', 'COMING_SOON', 'RESERVED', 'ON_HOLD', 'SOLD_OUT', 'INACTIVE')),
	CONSTRAINT "franchise_zones_reserved" CHECK ("status" <> 'RESERVED' OR ("reserved_for_dealer_id" IS NOT NULL AND "reserved_until" IS NOT NULL)),
	CONSTRAINT "franchise_zones_max_owners" CHECK ("max_owners" BETWEEN 1 AND 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zones_cluster_unique" ON "franchise_zones" ("zone_set_code", "cluster_no") WHERE NOT "is_test";
--> statement-breakpoint
-- The area master: every area of a zone set; zone_id null = Unzoned (free teams only, no franchise sale).
CREATE TABLE IF NOT EXISTS "franchise_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_set_code" text NOT NULL REFERENCES "franchise_zone_sets"("code") ON DELETE restrict,
	"area_no" integer NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"civic_body" text,
	"notes" text,
	"zone_id" text REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"lat" numeric(9, 6),
	"lng" numeric(9, 6),
	"pincodes" text[] DEFAULT '{}'::text[] NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"location_source" text DEFAULT 'APPROXIMATE' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_areas_location_source" CHECK ("location_source" IN ('APPROXIMATE', 'ADMIN'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_areas_name_unique" ON "franchise_areas" ("zone_set_code", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_areas_zone_idx" ON "franchise_areas" ("zone_id");
--> statement-breakpoint
-- Each change of an area's zone (audit; commission after the change follows the new zone).
CREATE TABLE IF NOT EXISTS "franchise_area_zone_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"area_id" uuid NOT NULL REFERENCES "franchise_areas"("id") ON DELETE restrict,
	"old_zone_id" text,
	"new_zone_id" text,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A shop's area (and so its zone) over time: one open period (valid_to null) per shop. An admin / operator
-- correction closes the open period and opens a new one, so commission before the change keeps the old zone.
CREATE TABLE IF NOT EXISTS "franchise_shop_area_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"area_id" uuid NOT NULL REFERENCES "franchise_areas"("id") ON DELETE restrict,
	"zone_id" text REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"source" text NOT NULL,
	"reason" text,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_shop_area_periods_source" CHECK ("source" IN ('REGISTRATION', 'ADMIN', 'OPERATOR', 'BACKFILL')),
	CONSTRAINT "franchise_shop_area_periods_dates" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_shop_area_periods_open_unique" ON "franchise_shop_area_periods" ("shop_id") WHERE "valid_to" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_shop_area_periods_zone_idx" ON "franchise_shop_area_periods" ("zone_id", "valid_from");
--> statement-breakpoint
-- A zone's business figure: the provisional index from the seed or an imported annual business (₹ Cr), with its
-- source and as-of date. An import is a batch of DRAFT rows; publishing makes them PUBLISHED (one per zone).
CREATE TABLE IF NOT EXISTS "franchise_zone_business" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"batch_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"source" text NOT NULL,
	"as_of" date NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "franchise_zone_business_metric" CHECK ("metric" IN ('INDEX', 'ANNUAL_CR')),
	CONSTRAINT "franchise_zone_business_value" CHECK ("value" >= 0),
	CONSTRAINT "franchise_zone_business_status" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_business_published_unique" ON "franchise_zone_business" ("zone_id") WHERE "status" = 'PUBLISHED';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_business_batch_unique" ON "franchise_zone_business" ("batch_id", "zone_id");
--> statement-breakpoint
-- A zone's tier and annual fee from a published business figure (brief §5.2). New bookings and renewals use the
-- current version; an active franchise keeps the fee it paid (franchise_allocations.fee_paise) for its term.
CREATE TABLE IF NOT EXISTS "franchise_zone_fee_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"business_id" uuid REFERENCES "franchise_zone_business"("id") ON DELETE restrict,
	"tier" text NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"average" numeric(14, 4) NOT NULL,
	"diff_bp" integer NOT NULL,
	"fee_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zone_fee_versions_tier" CHECK ("tier" IN ('PREMIER', 'STANDARD', 'EMERGING')),
	CONSTRAINT "franchise_zone_fee_versions_fee" CHECK ("fee_paise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_zone_fee_versions_current_unique" ON "franchise_zone_fee_versions" ("zone_id") WHERE "superseded_at" IS NULL;
--> statement-breakpoint
-- Every zone status change (who, old, new, reason, IST time shown in the app) and every scheduled change.
CREATE TABLE IF NOT EXISTS "franchise_zone_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE cascade,
	"old_status" text,
	"new_status" text NOT NULL,
	"reason" text NOT NULL,
	"reserved_for_dealer_id" uuid,
	"reserved_until" timestamp with time zone,
	"changed_by" uuid,
	"scheduled_for" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_zone_status_history_new" CHECK ("new_status" IN ('AVAILABLE', 'COMING_SOON', 'RESERVED', 'ON_HOLD', 'SOLD_OUT', 'INACTIVE'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_zone_status_history_zone_idx" ON "franchise_zone_status_history" ("zone_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_zone_status_history_due_idx" ON "franchise_zone_status_history" ("scheduled_for") WHERE "applied_at" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint
-- A zone's map shape (optional): reference point plus a polygon ([[lat, lng], ...]) or a circle. One APPROVED row.
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
-- Coupon codes on franchise fees (brief §5.7). The code is unique ignoring case; scope is
-- {"all":true} or any of {"zoneSets":[...],"tiers":[...],"zones":[...]}. EXPIRED is worked out from the dates
-- and the uses, never stored.
CREATE TABLE IF NOT EXISTS "franchise_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"discount_type" text NOT NULL,
	"percent_bp" integer,
	"flat_paise" bigint,
	"max_discount_paise" bigint,
	"scope" jsonb DEFAULT '{"all":true}'::jsonb NOT NULL,
	"applies_on" text DEFAULT 'BOTH' NOT NULL,
	"visibility" text DEFAULT 'PUBLIC' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"total_limit" integer,
	"per_dealer_limit" integer,
	"min_cart_paise" bigint,
	"first_purchase_only" boolean DEFAULT false NOT NULL,
	"launch_only" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_coupons_code" CHECK ("code" ~ '^[A-Za-z0-9_-]{3,30}$'),
	CONSTRAINT "franchise_coupons_type" CHECK (("discount_type" = 'PERCENT' AND "percent_bp" BETWEEN 1 AND 10000 AND "flat_paise" IS NULL) OR ("discount_type" = 'FLAT' AND "flat_paise" > 0 AND "percent_bp" IS NULL)),
	CONSTRAINT "franchise_coupons_applies_on" CHECK ("applies_on" IN ('NEW', 'RENEWAL', 'BOTH')),
	CONSTRAINT "franchise_coupons_visibility" CHECK ("visibility" IN ('PUBLIC', 'PRIVATE')),
	CONSTRAINT "franchise_coupons_status" CHECK ("status" IN ('ACTIVE', 'PAUSED')),
	CONSTRAINT "franchise_coupons_dates" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "franchise_coupons_limits" CHECK (coalesce("total_limit", 1) > 0 AND coalesce("per_dealer_limit", 1) > 0 AND coalesce("min_cart_paise", 0) >= 0 AND coalesce("max_discount_paise", 1) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_coupons_code_unique" ON "franchise_coupons" (lower("code"));
--> statement-breakpoint
-- A private coupon's dealers: by dealer, mobile (+91…) or e-mail.
CREATE TABLE IF NOT EXISTS "franchise_coupon_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL REFERENCES "franchise_coupons"("id") ON DELETE cascade,
	"dealer_id" uuid REFERENCES "dealers"("id") ON DELETE restrict,
	"mobile_e164" text,
	"email" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_coupon_assignments_one" CHECK (num_nonnulls("dealer_id", "mobile_e164", "email") = 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_coupon_assignments_coupon_idx" ON "franchise_coupon_assignments" ("coupon_id");
--> statement-breakpoint
-- A cart / order: one or more zones (NEW) or one allocation's renewal (RENEWAL), paid together. list = the zones'
-- list fees; base = list − discount (taxable); total = base + GST.
CREATE TABLE IF NOT EXISTS "franchise_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"kind" text DEFAULT 'NEW' NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"area_count" integer NOT NULL,
	"list_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"coupon_id" uuid REFERENCES "franchise_coupons"("id") ON DELETE restrict,
	"coupon_code" text,
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
	CONSTRAINT "franchise_bookings_status" CHECK ("status" IN ('RESERVED', 'PAYMENT_PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED')),
	CONSTRAINT "franchise_bookings_amounts" CHECK ("area_count" > 0 AND "list_paise" > 0 AND "discount_paise" >= 0 AND "base_paise" = "list_paise" - "discount_paise" AND "base_paise" >= "area_count" * 100 AND "gst_paise" >= 0 AND "total_paise" = "base_paise" + "gst_paise")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_bookings_owner_idx" ON "franchise_bookings" ("owner_dealer_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_bookings_intent_unique" ON "franchise_bookings" ("payment_intent_id") WHERE "payment_intent_id" IS NOT NULL;
--> statement-breakpoint
-- A coupon's use on one booking: HELD from checkout, USED once the payment succeeds, RELEASED when the payment
-- fails, times out or the booking is fully refunded. Limits count USED and live HELD uses.
CREATE TABLE IF NOT EXISTS "franchise_coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coupon_id" uuid NOT NULL REFERENCES "franchise_coupons"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"booking_id" uuid NOT NULL REFERENCES "franchise_bookings"("id") ON DELETE restrict,
	"discount_paise" bigint NOT NULL,
	"status" text DEFAULT 'HELD' NOT NULL,
	"held_until" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_coupon_redemptions_status" CHECK ("status" IN ('HELD', 'USED', 'RELEASED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_coupon_redemptions_booking_unique" ON "franchise_coupon_redemptions" ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "franchise_coupon_redemptions_coupon_idx" ON "franchise_coupon_redemptions" ("coupon_id", "status");
--> statement-breakpoint
-- One owner's slot in one zone. The capacity rule lives in the two partial unique indexes below: a zone has
-- slots 1 and 2 only, each held by one occupying allocation, and one owner never holds both. fee_paise is the
-- zone's list fee, locked for the term; discount_paise is this payment's coupon share.
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
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"tier" text NOT NULL,
	"fee_version_id" uuid REFERENCES "franchise_zone_fee_versions"("id") ON DELETE restrict,
	"config_version" integer NOT NULL REFERENCES "franchise_config_versions"("version") ON DELETE restrict,
	"launch_offer" boolean DEFAULT false NOT NULL,
	"launch_seq" integer,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_allocations_slot" CHECK ("slot_no" IN (1, 2)),
	CONSTRAINT "franchise_allocations_tier" CHECK ("tier" IN ('PREMIER', 'STANDARD', 'EMERGING')),
	CONSTRAINT "franchise_allocations_discount" CHECK ("discount_paise" >= 0 AND "discount_paise" < "fee_paise"),
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
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"tier" text,
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
-- A franchise code (GKF-xxxxxx), one per owner per franchise (allocation): an alias of the owner's own code that
-- is closed for new shops when the franchise expires. Who registered a shop is the code; its zone is its area.
CREATE TABLE IF NOT EXISTS "franchise_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL REFERENCES "referral_codes"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"allocation_id" uuid NOT NULL REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_codes_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'RETIRED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_codes_referral_unique" ON "franchise_codes" ("referral_code_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "franchise_codes_allocation_unique" ON "franchise_codes" ("allocation_id");
--> statement-breakpoint
-- A shop registered by a franchise owner's own team (or the owner) and the franchise it belongs to: Model B shops
-- (origin TEAM) and, on an upgrade from the free dealership, the team's earlier shops in the bought zone
-- (UPGRADE). The owner keeps recurring commission on these through the franchise's tail. Shops of free teams are
-- not here: they attach to the zone's active franchises month by month (brief §6).
CREATE TABLE IF NOT EXISTS "franchise_shop_attributions" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"owner_dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"allocation_id" uuid NOT NULL REFERENCES "franchise_allocations"("id") ON DELETE restrict,
	"zone_id" text NOT NULL REFERENCES "franchise_zones"("zone_id") ON DELETE restrict,
	"origin" text DEFAULT 'TEAM' NOT NULL,
	"franchise_code_id" uuid REFERENCES "franchise_codes"("id") ON DELETE restrict,
	"member_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE restrict,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"hold_reason" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "franchise_shop_attributions_origin" CHECK ("origin" IN ('TEAM', 'UPGRADE')),
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
-- The monthly bonus calculation per franchise (brief §4.1): opening shops (frozen at the first run), baseline, new
-- shops, business, points, bonus, rate and the payout lines. DRAFT until the payout is locked on the 5th; after
-- that it never changes and later corrections go to the next month's adjustments.
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
-- Every expiry reminder / alert / digest / zone notice sent (recipient, channel, time) — also the guard against
-- sending twice.
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
-- Each shop's frozen commission plan records the model and case (A1–A4 free dealership, B1–B4 paid franchise) and,
-- for Model B, the franchise and zone (brief §3: a hierarchy snapshot on every commission record).
ALTER TABLE "dealer_tier_shop_plans" ADD COLUMN IF NOT EXISTS "model" text DEFAULT 'A' NOT NULL;
--> statement-breakpoint
ALTER TABLE "dealer_tier_shop_plans" ADD COLUMN IF NOT EXISTS "case_code" text;
--> statement-breakpoint
ALTER TABLE "dealer_tier_shop_plans" ADD COLUMN IF NOT EXISTS "franchise_allocation_id" uuid REFERENCES "franchise_allocations"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "dealer_tier_shop_plans" ADD COLUMN IF NOT EXISTS "franchise_zone_id" text;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dealer_tier_shop_plans_model') THEN
		ALTER TABLE "dealer_tier_shop_plans" ADD CONSTRAINT "dealer_tier_shop_plans_model" CHECK ("model" IN ('A', 'B'));
	END IF;
END $$;
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
INSERT INTO "franchise_zone_sets" ("code", "name", "state") VALUES ('PUN', 'Pune', 'Maharashtra') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_campaigns" ("code") VALUES ('LAUNCH') ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The 50 Pune franchise zones (one cluster each), Available at the launch offer (owner, 21-Nov-2026 09.20 IST).
INSERT INTO "franchise_zones" ("zone_id", "zone_set_code", "cluster_no", "name", "region", "civic_body", "reason", "status", "status_reason") VALUES
	('GKZ-PUN-01', 'PUN', 1, 'Peth West', 'Central', 'PMC', 'Dense old-city retail peths', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-02', 'PUN', 2, 'Peth East', 'Central', 'PMC', 'Wholesale trade peths (Raviwar, Budhwar, Ganj)', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-03', 'PUN', 3, 'Shivajinagar–Deccan', 'Central', 'PMC', 'FC/JM Road high street, education hub', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-04', 'PUN', 4, 'Swargate–Market Yard', 'Central', 'PMC', 'APMC wholesale market, transport hub', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-05', 'PUN', 5, 'Camp–Pune Station', 'Central', 'PMC / Cantonment', 'MG Road retail, railway station', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-06', 'PUN', 6, 'Kothrud', 'West', 'PMC', 'Large affluent residential market', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-07', 'PUN', 7, 'Karve Nagar–Erandwane', 'West', 'PMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-08', 'PUN', 8, 'Warje–Shivane', 'West', 'PMC', 'Growing residential, newer merged areas', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-09', 'PUN', 9, 'Bavdhan–Sus', 'West', 'PMC', 'Newer residential, low shop density', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-10', 'PUN', 10, 'Baner–Balewadi', 'North-West', 'PMC', 'IT offices and high street', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-11', 'PUN', 11, 'Aundh–Pashan', 'North-West', 'PMC', 'Affluent residential, university area', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-12', 'PUN', 12, 'Khadki–Bopodi', 'North-West', 'PMC / Cantonment', 'Cantonment, limited retail', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-13', 'PUN', 13, 'Yerawada', 'North', 'PMC', 'Mixed residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-14', 'PUN', 14, 'Vishrantwadi–Dhanori', 'North', 'PMC', 'Growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-15', 'PUN', 15, 'Lohegaon', 'North', 'PMC', 'Airport area, lower shop density', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-16', 'PUN', 16, 'Viman Nagar–Kalyani Nagar', 'North / East', 'PMC', 'Premium residential and malls', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-17', 'PUN', 17, 'Koregaon Park–Mundhwa', 'East', 'PMC', 'Premium residential, dining', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-18', 'PUN', 18, 'Wadgaon Sheri–Chandan Nagar', 'East', 'PMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-19', 'PUN', 19, 'Kharadi', 'East', 'PMC', 'IT hub (EON IT Park)', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-20', 'PUN', 20, 'Wagholi', 'East', 'PMC / Gram Panchayat', 'Fast-growing fringe', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-21', 'PUN', 21, 'Hadapsar', 'South-East', 'PMC', 'Large population and market', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-22', 'PUN', 22, 'Magarpatta–Amanora', 'South-East', 'PMC', 'IT townships', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-23', 'PUN', 23, 'Manjri–Shewalewadi', 'South-East', 'PMC', 'Newly merged, developing', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-24', 'PUN', 24, 'Wanowrie–Fatima Nagar', 'South-East', 'PMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-25', 'PUN', 25, 'Kondhwa–NIBM', 'South-East', 'PMC', 'Dense residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-26', 'PUN', 26, 'Undri–Pisoli', 'South-East', 'PMC', 'Newly merged, developing', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-27', 'PUN', 27, 'Fursungi–Uruli Devachi', 'South-East', 'Municipal Council', 'Peri-urban council area', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-28', 'PUN', 28, 'Bibwewadi', 'South', 'PMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-29', 'PUN', 29, 'Sahakar Nagar–Dhankawadi', 'South', 'PMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-30', 'PUN', 30, 'Katraj', 'South', 'PMC', 'Residential, highway trade', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-31', 'PUN', 31, 'Ambegaon', 'South', 'PMC', 'Newly merged, developing', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-32', 'PUN', 32, 'Sinhagad Road', 'South', 'PMC', 'Dense residential corridor', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-33', 'PUN', 33, 'Dhayari–Narhe', 'South', 'PMC', 'Growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-34', 'PUN', 34, 'Nanded City–Khadakwasla', 'South', 'PMC', 'Township and newly merged villages', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-35', 'PUN', 35, 'Pimpri', 'Pimpri-Chinchwad', 'PCMC', 'Pimpri market, PCMC trade centre', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-36', 'PUN', 36, 'Chinchwad', 'Pimpri-Chinchwad', 'PCMC', 'Established commercial', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-37', 'PUN', 37, 'Akurdi–Nigdi', 'Pimpri-Chinchwad', 'PCMC', 'Planned residential (Pradhikaran)', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-38', 'PUN', 38, 'Bhosari', 'Pimpri-Chinchwad', 'PCMC', 'MIDC industrial area', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-39', 'PUN', 39, 'Moshi–Chikhali', 'Pimpri-Chinchwad', 'PCMC', 'Growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-40', 'PUN', 40, 'Dighi–Charholi', 'Pimpri-Chinchwad', 'PCMC', 'Developing fringe', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-41', 'PUN', 41, 'Wakad', 'Pimpri-Chinchwad', 'PCMC', 'IT-linked premium residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-42', 'PUN', 42, 'Thergaon–Rahatani', 'Pimpri-Chinchwad', 'PCMC', 'Dense residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-43', 'PUN', 43, 'Ravet–Punawale', 'Pimpri-Chinchwad', 'PCMC', 'Fast-growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-44', 'PUN', 44, 'Pimple Saudagar–Gurav', 'Pimpri-Chinchwad', 'PCMC', 'Affluent residential, high street', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-45', 'PUN', 45, 'Sangvi–Dapodi', 'Pimpri-Chinchwad', 'PCMC', 'Established residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-46', 'PUN', 46, 'Hinjewadi', 'Fringe', 'Gram Panchayat (PMRDA)', 'Rajiv Gandhi Infotech Park', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-47', 'PUN', 47, 'Pirangut–Mulshi', 'Fringe', 'Gram Panchayat (PMRDA)', 'Rural-fringe villages', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-48', 'PUN', 48, 'Dehu Road–Talegaon', 'Fringe', 'Cantonment / Councils', 'Cantonment and council towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-49', 'PUN', 49, 'Chakan–Alandi', 'Fringe', 'Municipal Councils', 'Auto/industrial hub, pilgrimage town', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)'),
	('GKZ-PUN-50', 'PUN', 50, 'Loni Kalbhor–Theur', 'Fringe', 'Gram Panchayat (PMRDA)', 'Rural-fringe villages', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The area master: 196 areas; zone_id null = Unzoned. Coordinates and PIN codes are approximate (for the
-- registration suggestion only, which the user confirms) until an admin corrects them.
INSERT INTO "franchise_areas" ("zone_set_code", "area_no", "name", "region", "civic_body", "notes", "zone_id", "lat", "lng", "pincodes", "aliases") VALUES
	('PUN', 1, 'Shivajinagar', 'Central', 'PMC', 'Commercial & education hub', 'GKZ-PUN-03', 18.5308, 73.8475, ARRAY['411005']::text[], '{}'::text[]),
	('PUN', 2, 'Deccan Gymkhana', 'Central', 'PMC', 'FC Road / JM Road', 'GKZ-PUN-03', 18.5167, 73.8411, ARRAY['411004']::text[], '{}'::text[]),
	('PUN', 3, 'Sadashiv Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-01', 18.5106, 73.8475, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 4, 'Narayan Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-01', 18.5145, 73.8510, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 5, 'Shaniwar Peth', 'Central', 'PMC', 'Old city peth; Shaniwar Wada', 'GKZ-PUN-01', 18.5180, 73.8530, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 6, 'Budhwar Peth', 'Central', 'PMC', 'Old city peth; Dagdusheth temple', 'GKZ-PUN-02', 18.5164, 73.8567, ARRAY['411002']::text[], ARRAY['Budhwar']::text[]),
	('PUN', 7, 'Shukrawar Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-01', 18.5080, 73.8560, ARRAY['411002']::text[], '{}'::text[]),
	('PUN', 8, 'Raviwar Peth', 'Central', 'PMC', 'Old city peth; wholesale market', 'GKZ-PUN-02', 18.5150, 73.8610, ARRAY['411002']::text[], ARRAY['Raviwar']::text[]),
	('PUN', 9, 'Kasba Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5203, 73.8590, ARRAY['411011']::text[], ARRAY['Kasba']::text[]),
	('PUN', 10, 'Somwar Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5200, 73.8680, ARRAY['411011']::text[], ARRAY['Somwar']::text[]),
	('PUN', 11, 'Mangalwar Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5230, 73.8650, ARRAY['411011']::text[], ARRAY['Mangalwar']::text[]),
	('PUN', 12, 'Rasta Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5170, 73.8690, ARRAY['411011']::text[], '{}'::text[]),
	('PUN', 13, 'Nana Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5120, 73.8670, ARRAY['411002']::text[], ARRAY['Nana']::text[]),
	('PUN', 14, 'Bhavani Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5070, 73.8650, ARRAY['411042']::text[], ARRAY['Bhavani']::text[]),
	('PUN', 15, 'Ganesh Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5110, 73.8620, ARRAY['411002']::text[], ARRAY['Ganesh']::text[]),
	('PUN', 16, 'Guruwar Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5060, 73.8600, ARRAY['411042']::text[], ARRAY['Guruwar']::text[]),
	('PUN', 17, 'Ghorpade Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5030, 73.8620, ARRAY['411042']::text[], ARRAY['Ghorpade']::text[]),
	('PUN', 18, 'Ganj Peth (Mahatma Phule Peth)', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-02', 18.5040, 73.8660, ARRAY['411042']::text[], ARRAY['Ganj']::text[]),
	('PUN', 19, 'Navi Peth', 'Central', 'PMC', 'Old city peth', 'GKZ-PUN-01', 18.5070, 73.8460, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 20, 'Swargate', 'Central', 'PMC', 'Bus & metro hub', 'GKZ-PUN-04', 18.5018, 73.8636, ARRAY['411042']::text[], '{}'::text[]),
	('PUN', 21, 'Model Colony', 'Central', 'PMC', NULL, 'GKZ-PUN-03', 18.5285, 73.8380, ARRAY['411016']::text[], '{}'::text[]),
	('PUN', 22, 'Prabhat Road', 'Central', 'PMC', NULL, 'GKZ-PUN-03', 18.5130, 73.8330, ARRAY['411004']::text[], '{}'::text[]),
	('PUN', 23, 'Camp (Pune Cantonment)', 'Central', 'Pune Cantonment Board', 'MG Road / East Street', 'GKZ-PUN-05', 18.5150, 73.8780, ARRAY['411001']::text[], ARRAY['Camp']::text[]),
	('PUN', 24, 'Pune Station', 'Central', 'PMC', 'Railway station area', 'GKZ-PUN-05', 18.5289, 73.8744, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 25, 'Mukund Nagar', 'Central', 'PMC', NULL, 'GKZ-PUN-04', 18.4930, 73.8610, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 26, 'Gultekdi', 'Central', 'PMC', NULL, 'GKZ-PUN-04', 18.4930, 73.8680, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 27, 'Market Yard', 'Central', 'PMC', 'APMC wholesale market', 'GKZ-PUN-04', 18.4880, 73.8700, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 28, 'Parvati', 'Central', 'PMC', NULL, 'GKZ-PUN-04', 18.4960, 73.8480, ARRAY['411009']::text[], '{}'::text[]),
	('PUN', 29, 'Salisbury Park', 'Central', 'PMC', NULL, 'GKZ-PUN-04', 18.4930, 73.8740, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 30, 'Maharshi Nagar', 'Central', 'PMC', NULL, 'GKZ-PUN-04', 18.4890, 73.8650, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 31, 'Kothrud', 'West', 'PMC', NULL, 'GKZ-PUN-06', 18.5074, 73.8077, ARRAY['411038']::text[], '{}'::text[]),
	('PUN', 32, 'Karve Nagar', 'West', 'PMC', NULL, 'GKZ-PUN-07', 18.4890, 73.8190, ARRAY['411052']::text[], '{}'::text[]),
	('PUN', 33, 'Erandwane', 'West', 'PMC', NULL, 'GKZ-PUN-07', 18.5080, 73.8300, ARRAY['411004']::text[], '{}'::text[]),
	('PUN', 34, 'Warje', 'West', 'PMC', NULL, 'GKZ-PUN-08', 18.4820, 73.8020, ARRAY['411058']::text[], '{}'::text[]),
	('PUN', 35, 'Bavdhan', 'West', 'PMC', 'Bavdhan Budruk merged into PMC (2021)', 'GKZ-PUN-09', 18.5180, 73.7790, ARRAY['411021']::text[], '{}'::text[]),
	('PUN', 36, 'Paud Road', 'West', 'PMC', NULL, 'GKZ-PUN-06', 18.5080, 73.8150, ARRAY['411038']::text[], '{}'::text[]),
	('PUN', 37, 'Bhusari Colony', 'West', 'PMC', NULL, 'GKZ-PUN-06', 18.5030, 73.7920, ARRAY['411038']::text[], '{}'::text[]),
	('PUN', 38, 'Dahanukar Colony', 'West', 'PMC', NULL, 'GKZ-PUN-06', 18.4990, 73.8160, ARRAY['411038']::text[], '{}'::text[]),
	('PUN', 39, 'Shivane', 'West', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-08', 18.4660, 73.7870, ARRAY['411023']::text[], '{}'::text[]),
	('PUN', 40, 'Uttam Nagar', 'West', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-08', 18.4700, 73.7930, ARRAY['411023']::text[], '{}'::text[]),
	('PUN', 41, 'Kondhwe Dhawade', 'West', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-08', 18.4600, 73.7780, ARRAY['411023']::text[], '{}'::text[]),
	('PUN', 42, 'Kopare', 'West', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-08', 18.4750, 73.8000, ARRAY['411023']::text[], '{}'::text[]),
	('PUN', 43, 'Aundh', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5580, 73.8075, ARRAY['411007']::text[], '{}'::text[]),
	('PUN', 44, 'Baner', 'North-West', 'PMC', 'IT offices & high street', 'GKZ-PUN-10', 18.5590, 73.7868, ARRAY['411045']::text[], '{}'::text[]),
	('PUN', 45, 'Balewadi', 'North-West', 'PMC', 'Sports complex', 'GKZ-PUN-10', 18.5770, 73.7790, ARRAY['411045']::text[], '{}'::text[]),
	('PUN', 46, 'Pashan', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5370, 73.7960, ARRAY['411021']::text[], '{}'::text[]),
	('PUN', 47, 'Sutarwadi', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5450, 73.7900, ARRAY['411021']::text[], '{}'::text[]),
	('PUN', 48, 'Sus', 'North-West', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-09', 18.5470, 73.7570, ARRAY['411021']::text[], '{}'::text[]),
	('PUN', 49, 'Mahalunge', 'North-West', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-10', 18.5700, 73.7550, ARRAY['411045']::text[], '{}'::text[]),
	('PUN', 50, 'Gokhale Nagar', 'North-West', 'PMC', NULL, 'GKZ-PUN-03', 18.5290, 73.8300, ARRAY['411016']::text[], '{}'::text[]),
	('PUN', 51, 'Senapati Bapat Road', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5300, 73.8290, ARRAY['411016']::text[], '{}'::text[]),
	('PUN', 52, 'Chatushringi', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5390, 73.8290, ARRAY['411016']::text[], '{}'::text[]),
	('PUN', 53, 'Ganeshkhind (University area)', 'North-West', 'PMC', NULL, 'GKZ-PUN-11', 18.5510, 73.8250, ARRAY['411007']::text[], ARRAY['Ganeshkhind']::text[]),
	('PUN', 54, 'Bopodi', 'North-West', 'PMC', NULL, 'GKZ-PUN-12', 18.5700, 73.8330, ARRAY['411003']::text[], '{}'::text[]),
	('PUN', 55, 'Khadki', 'North-West', 'Khadki Cantonment Board', NULL, 'GKZ-PUN-12', 18.5640, 73.8460, ARRAY['411003']::text[], '{}'::text[]),
	('PUN', 56, 'Yerawada', 'North', 'PMC', NULL, 'GKZ-PUN-13', 18.5520, 73.8850, ARRAY['411006']::text[], '{}'::text[]),
	('PUN', 57, 'Vishrantwadi', 'North', 'PMC', NULL, 'GKZ-PUN-14', 18.5720, 73.8780, ARRAY['411015']::text[], '{}'::text[]),
	('PUN', 58, 'Dhanori', 'North', 'PMC', NULL, 'GKZ-PUN-14', 18.5880, 73.8960, ARRAY['411015']::text[], '{}'::text[]),
	('PUN', 59, 'Kalas', 'North', 'PMC', NULL, 'GKZ-PUN-14', 18.5800, 73.8720, ARRAY['411015']::text[], '{}'::text[]),
	('PUN', 60, 'Tingre Nagar', 'North', 'PMC', NULL, 'GKZ-PUN-14', 18.5730, 73.8880, ARRAY['411032']::text[], '{}'::text[]),
	('PUN', 61, 'Lohegaon', 'North', 'PMC', 'Pune Airport', 'GKZ-PUN-15', 18.5960, 73.9200, ARRAY['411047']::text[], ARRAY['Lohegaon (airport area)']::text[]),
	('PUN', 62, 'Porwal Road', 'North', 'PMC', NULL, 'GKZ-PUN-14', 18.5930, 73.9050, ARRAY['411047']::text[], '{}'::text[]),
	('PUN', 63, 'Sangamwadi', 'North', 'PMC', NULL, 'GKZ-PUN-05', 18.5370, 73.8680, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 64, 'Phule Nagar', 'North', 'PMC', NULL, 'GKZ-PUN-13', 18.5610, 73.8770, ARRAY['411006']::text[], '{}'::text[]),
	('PUN', 65, 'Shastri Nagar', 'North', 'PMC', NULL, 'GKZ-PUN-13', 18.5470, 73.8890, ARRAY['411006']::text[], '{}'::text[]),
	('PUN', 66, 'Koregaon Park', 'East', 'PMC', NULL, 'GKZ-PUN-17', 18.5362, 73.8940, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 67, 'Kalyani Nagar', 'East', 'PMC', NULL, 'GKZ-PUN-16', 18.5480, 73.9020, ARRAY['411006']::text[], '{}'::text[]),
	('PUN', 68, 'Viman Nagar', 'East', 'PMC', NULL, 'GKZ-PUN-16', 18.5679, 73.9143, ARRAY['411014']::text[], '{}'::text[]),
	('PUN', 69, 'Wadgaon Sheri', 'East', 'PMC', NULL, 'GKZ-PUN-18', 18.5520, 73.9230, ARRAY['411014']::text[], '{}'::text[]),
	('PUN', 70, 'Kharadi', 'East', 'PMC', 'IT hub (EON IT Park)', 'GKZ-PUN-19', 18.5510, 73.9400, ARRAY['411014']::text[], '{}'::text[]),
	('PUN', 71, 'Chandan Nagar', 'East', 'PMC', NULL, 'GKZ-PUN-18', 18.5620, 73.9330, ARRAY['411014']::text[], '{}'::text[]),
	('PUN', 72, 'Wagholi', 'East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-20', 18.5800, 73.9820, ARRAY['412207']::text[], '{}'::text[]),
	('PUN', 73, 'Mundhwa', 'East', 'PMC', NULL, 'GKZ-PUN-17', 18.5330, 73.9300, ARRAY['411036']::text[], '{}'::text[]),
	('PUN', 74, 'Keshav Nagar', 'East', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-17', 18.5370, 73.9420, ARRAY['411036']::text[], '{}'::text[]),
	('PUN', 75, 'Ghorpadi', 'East', 'PMC', NULL, 'GKZ-PUN-17', 18.5260, 73.8960, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 76, 'Bund Garden', 'East', 'PMC', NULL, 'GKZ-PUN-05', 18.5370, 73.8820, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 77, 'Dhole Patil Road', 'East', 'PMC', NULL, 'GKZ-PUN-05', 18.5330, 73.8790, ARRAY['411001']::text[], '{}'::text[]),
	('PUN', 78, 'Hadapsar', 'South-East', 'PMC', NULL, 'GKZ-PUN-21', 18.5089, 73.9260, ARRAY['411028']::text[], '{}'::text[]),
	('PUN', 79, 'Magarpatta City', 'South-East', 'PMC', 'IT township', 'GKZ-PUN-22', 18.5150, 73.9290, ARRAY['411013']::text[], '{}'::text[]),
	('PUN', 80, 'Amanora Park Town', 'South-East', 'PMC', 'Township', 'GKZ-PUN-22', 18.5180, 73.9400, ARRAY['411028']::text[], '{}'::text[]),
	('PUN', 81, 'Sasane Nagar', 'South-East', 'PMC', NULL, 'GKZ-PUN-21', 18.4960, 73.9300, ARRAY['411028']::text[], '{}'::text[]),
	('PUN', 82, 'Satav Nagar', 'South-East', 'PMC', NULL, 'GKZ-PUN-22', 18.5040, 73.9380, ARRAY['411028']::text[], '{}'::text[]),
	('PUN', 83, 'Ramtekdi', 'South-East', 'PMC', NULL, 'GKZ-PUN-21', 18.5000, 73.9150, ARRAY['411013']::text[], '{}'::text[]),
	('PUN', 84, 'Fatima Nagar', 'South-East', 'PMC', NULL, 'GKZ-PUN-24', 18.5050, 73.8990, ARRAY['411013']::text[], '{}'::text[]),
	('PUN', 85, 'Wanowrie', 'South-East', 'PMC', NULL, 'GKZ-PUN-24', 18.4930, 73.9000, ARRAY['411040']::text[], '{}'::text[]),
	('PUN', 86, 'Salunke Vihar', 'South-East', 'PMC', NULL, 'GKZ-PUN-24', 18.4850, 73.8990, ARRAY['411048']::text[], '{}'::text[]),
	('PUN', 87, 'Lullanagar', 'South-East', 'PMC', NULL, 'GKZ-PUN-24', 18.4860, 73.8890, ARRAY['411040']::text[], '{}'::text[]),
	('PUN', 88, 'Kondhwa Khurd', 'South-East', 'PMC', NULL, 'GKZ-PUN-25', 18.4750, 73.8900, ARRAY['411048']::text[], '{}'::text[]),
	('PUN', 89, 'Kondhwa Budruk', 'South-East', 'PMC', NULL, 'GKZ-PUN-25', 18.4560, 73.8800, ARRAY['411048']::text[], '{}'::text[]),
	('PUN', 90, 'NIBM Road', 'South-East', 'PMC', NULL, 'GKZ-PUN-25', 18.4730, 73.9000, ARRAY['411048']::text[], '{}'::text[]),
	('PUN', 91, 'Undri', 'South-East', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-26', 18.4560, 73.9060, ARRAY['411060']::text[], '{}'::text[]),
	('PUN', 92, 'Pisoli', 'South-East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-26', 18.4450, 73.9050, ARRAY['411060']::text[], '{}'::text[]),
	('PUN', 93, 'Mohammed Wadi', 'South-East', 'PMC', NULL, 'GKZ-PUN-26', 18.4700, 73.9200, ARRAY['411060']::text[], '{}'::text[]),
	('PUN', 94, 'Handewadi', 'South-East', 'PMC', 'Autade Handewadi merged into PMC (2021)', 'GKZ-PUN-26', 18.4560, 73.9320, ARRAY['411060']::text[], '{}'::text[]),
	('PUN', 95, 'Holkarwadi', 'South-East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-26', 18.4460, 73.9250, ARRAY['412308']::text[], '{}'::text[]),
	('PUN', 96, 'Wadachi Wadi', 'South-East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-26', 18.4380, 73.9150, ARRAY['411060']::text[], '{}'::text[]),
	('PUN', 97, 'Yewalewadi', 'South-East', 'PMC', NULL, 'GKZ-PUN-30', 18.4440, 73.8730, ARRAY['411048']::text[], '{}'::text[]),
	('PUN', 98, 'Manjri Budruk', 'South-East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-23', 18.5100, 73.9700, ARRAY['412307']::text[], '{}'::text[]),
	('PUN', 99, 'Shewalewadi', 'South-East', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-23', 18.4990, 73.9620, ARRAY['412307']::text[], '{}'::text[]),
	('PUN', 100, 'Katraj', 'South', 'PMC', NULL, 'GKZ-PUN-30', 18.4529, 73.8650, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 101, 'Dhankawadi', 'South', 'PMC', NULL, 'GKZ-PUN-29', 18.4630, 73.8540, ARRAY['411043']::text[], '{}'::text[]),
	('PUN', 102, 'Balaji Nagar', 'South', 'PMC', NULL, 'GKZ-PUN-29', 18.4660, 73.8580, ARRAY['411043']::text[], '{}'::text[]),
	('PUN', 103, 'Bibwewadi', 'South', 'PMC', NULL, 'GKZ-PUN-28', 18.4730, 73.8650, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 104, 'Upper Indira Nagar', 'South', 'PMC', NULL, 'GKZ-PUN-28', 18.4700, 73.8700, ARRAY['411037']::text[], '{}'::text[]),
	('PUN', 105, 'Sahakar Nagar', 'South', 'PMC', NULL, 'GKZ-PUN-29', 18.4830, 73.8550, ARRAY['411009']::text[], '{}'::text[]),
	('PUN', 106, 'Padmavati', 'South', 'PMC', NULL, 'GKZ-PUN-28', 18.4800, 73.8590, ARRAY['411009']::text[], '{}'::text[]),
	('PUN', 107, 'Gokul Nagar', 'South', 'PMC', NULL, 'GKZ-PUN-30', 18.4500, 73.8700, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 108, 'Sinhagad Road', 'South', 'PMC', NULL, 'GKZ-PUN-32', 18.4800, 73.8270, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 109, 'Vadgaon Budruk', 'South', 'PMC', NULL, 'GKZ-PUN-32', 18.4650, 73.8200, ARRAY['411041']::text[], '{}'::text[]),
	('PUN', 110, 'Anand Nagar', 'South', 'PMC', 'On Sinhagad Road', 'GKZ-PUN-32', 18.4780, 73.8240, ARRAY['411051']::text[], '{}'::text[]),
	('PUN', 111, 'Manik Baug', 'South', 'PMC', NULL, 'GKZ-PUN-32', 18.4730, 73.8220, ARRAY['411051']::text[], '{}'::text[]),
	('PUN', 112, 'Hingne Khurd', 'South', 'PMC', NULL, 'GKZ-PUN-07', 18.4850, 73.8150, ARRAY['411051']::text[], '{}'::text[]),
	('PUN', 113, 'Vitthalwadi', 'South', 'PMC', NULL, 'GKZ-PUN-32', 18.4880, 73.8250, ARRAY['411030']::text[], '{}'::text[]),
	('PUN', 114, 'Dhayari', 'South', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-33', 18.4500, 73.8130, ARRAY['411041']::text[], '{}'::text[]),
	('PUN', 115, 'Narhe', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-33', 18.4460, 73.8300, ARRAY['411041']::text[], '{}'::text[]),
	('PUN', 116, 'Ambegaon Budruk', 'South', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-31', 18.4500, 73.8450, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 117, 'Ambegaon Khurd', 'South', 'PMC', 'Merged into PMC (2017)', 'GKZ-PUN-31', 18.4420, 73.8400, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 118, 'Jambhulwadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-31', 18.4300, 73.8500, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 119, 'Mangdewadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-31', 18.4250, 73.8650, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 120, 'Bhilarewadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-31', 18.4200, 73.8600, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 121, 'Gujar Nimbalkarwadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-31', 18.4300, 73.8800, ARRAY['411046']::text[], '{}'::text[]),
	('PUN', 122, 'Nanded City', 'South', 'PMC', 'Nanded village merged into PMC (2021)', 'GKZ-PUN-34', 18.4600, 73.7980, ARRAY['411068']::text[], '{}'::text[]),
	('PUN', 123, 'Kirkatwadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-34', 18.4400, 73.7900, ARRAY['411024']::text[], '{}'::text[]),
	('PUN', 124, 'Khadakwasla', 'South', 'PMC', 'Merged into PMC (2021); dam', 'GKZ-PUN-34', 18.4400, 73.7700, ARRAY['411024']::text[], '{}'::text[]),
	('PUN', 125, 'Nandoshi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-34', 18.4300, 73.7800, ARRAY['411024']::text[], '{}'::text[]),
	('PUN', 126, 'Sanasnagar', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-34', 18.4250, 73.7900, ARRAY['411024']::text[], '{}'::text[]),
	('PUN', 127, 'Kolewadi', 'South', 'PMC', 'Merged into PMC (2021)', 'GKZ-PUN-34', 18.4200, 73.7750, ARRAY['411024']::text[], '{}'::text[]),
	('PUN', 128, 'Pimpri', 'Pimpri-Chinchwad', 'PCMC', 'Pimpri market / camp', 'GKZ-PUN-35', 18.6279, 73.8009, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 129, 'Chinchwad', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-36', 18.6440, 73.7900, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 130, 'Chinchwadgaon', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-36', 18.6360, 73.7800, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 131, 'Akurdi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-37', 18.6480, 73.7700, ARRAY['411035']::text[], '{}'::text[]),
	('PUN', 132, 'Nigdi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-37', 18.6560, 73.7700, ARRAY['411044']::text[], '{}'::text[]),
	('PUN', 133, 'Pradhikaran (Nigdi)', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-37', 18.6500, 73.7600, ARRAY['411044']::text[], ARRAY['Pradhikaran']::text[]),
	('PUN', 134, 'Yamuna Nagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-37', 18.6600, 73.7800, ARRAY['411044']::text[], '{}'::text[]),
	('PUN', 135, 'Bhosari', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-38', 18.6290, 73.8480, ARRAY['411039']::text[], '{}'::text[]),
	('PUN', 136, 'MIDC Bhosari', 'Pimpri-Chinchwad', 'PCMC', 'Industrial area', 'GKZ-PUN-38', 18.6370, 73.8400, ARRAY['411026']::text[], '{}'::text[]),
	('PUN', 137, 'Moshi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-39', 18.6700, 73.8500, ARRAY['412105']::text[], '{}'::text[]),
	('PUN', 138, 'Chikhali', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-39', 18.6800, 73.8100, ARRAY['411062']::text[], '{}'::text[]),
	('PUN', 139, 'Dighi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-40', 18.6150, 73.8700, ARRAY['411015']::text[], '{}'::text[]),
	('PUN', 140, 'Charholi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-40', 18.6400, 73.8900, ARRAY['412105']::text[], '{}'::text[]),
	('PUN', 141, 'Talawade', 'Pimpri-Chinchwad', 'PCMC', 'IT park', 'GKZ-PUN-39', 18.6900, 73.7800, ARRAY['411062']::text[], '{}'::text[]),
	('PUN', 142, 'Dudulgaon', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-40', 18.6600, 73.8800, ARRAY['412105']::text[], '{}'::text[]),
	('PUN', 143, 'Wakad', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-41', 18.5990, 73.7620, ARRAY['411057']::text[], '{}'::text[]),
	('PUN', 144, 'Tathawade', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-43', 18.6200, 73.7450, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 145, 'Punawale', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-43', 18.6300, 73.7400, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 146, 'Ravet', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-43', 18.6450, 73.7450, ARRAY['412101']::text[], '{}'::text[]),
	('PUN', 147, 'Kiwale', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-43', 18.6550, 73.7350, ARRAY['412101']::text[], '{}'::text[]),
	('PUN', 148, 'Mamurdi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-43', 18.6650, 73.7200, ARRAY['412101']::text[], '{}'::text[]),
	('PUN', 149, 'Thergaon', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-42', 18.6100, 73.7750, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 150, 'Kalewadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-42', 18.6150, 73.7900, ARRAY['411017']::text[], '{}'::text[]),
	('PUN', 151, 'Rahatani', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-42', 18.6000, 73.7900, ARRAY['411017']::text[], '{}'::text[]),
	('PUN', 152, 'Pimple Saudagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-44', 18.5990, 73.8040, ARRAY['411027']::text[], '{}'::text[]),
	('PUN', 153, 'Pimple Gurav', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-44', 18.5900, 73.8150, ARRAY['411061']::text[], '{}'::text[]),
	('PUN', 154, 'Pimple Nilakh', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-44', 18.5800, 73.7950, ARRAY['411027']::text[], '{}'::text[]),
	('PUN', 155, 'Sangvi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-45', 18.5770, 73.8200, ARRAY['411027']::text[], '{}'::text[]),
	('PUN', 156, 'New Sangvi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-45', 18.5850, 73.8180, ARRAY['411027']::text[], '{}'::text[]),
	('PUN', 157, 'Dapodi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-45', 18.5800, 73.8350, ARRAY['411012']::text[], '{}'::text[]),
	('PUN', 158, 'Kasarwadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-45', 18.6000, 73.8250, ARRAY['411034']::text[], '{}'::text[]),
	('PUN', 159, 'Phugewadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-45', 18.5900, 73.8350, ARRAY['411012']::text[], '{}'::text[]),
	('PUN', 160, 'Nehru Nagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-35', 18.6250, 73.8150, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 161, 'Sant Tukaram Nagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-35', 18.6200, 73.8120, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 162, 'Masulkar Colony', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-35', 18.6300, 73.8150, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 163, 'Kharalwadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-35', 18.6250, 73.8050, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 164, 'Morwadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-35', 18.6300, 73.8000, ARRAY['411018']::text[], '{}'::text[]),
	('PUN', 165, 'Bijalinagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-36', 18.6400, 73.7750, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 166, 'Walhekarwadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-36', 18.6450, 73.7650, ARRAY['411033']::text[], '{}'::text[]),
	('PUN', 167, 'Kudalwadi', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-39', 18.6750, 73.8300, ARRAY['412114']::text[], '{}'::text[]),
	('PUN', 168, 'Indrayani Nagar', 'Pimpri-Chinchwad', 'PCMC', NULL, 'GKZ-PUN-38', 18.6400, 73.8550, ARRAY['411026']::text[], '{}'::text[]),
	('PUN', 169, 'Hinjewadi', 'Outskirts', 'Gram Panchayat (PMRDA area)', 'Rajiv Gandhi Infotech Park', 'GKZ-PUN-46', 18.5913, 73.7389, ARRAY['411057']::text[], '{}'::text[]),
	('PUN', 170, 'Maan', 'Outskirts', 'Gram Panchayat (PMRDA area)', 'Hinjewadi IT Park Phase 3', 'GKZ-PUN-46', 18.5850, 73.6950, ARRAY['411057']::text[], '{}'::text[]),
	('PUN', 171, 'Marunji', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-46', 18.6050, 73.7250, ARRAY['411057']::text[], '{}'::text[]),
	('PUN', 172, 'Pirangut', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5100, 73.6800, ARRAY['412115']::text[], '{}'::text[]),
	('PUN', 173, 'Bhugaon', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5000, 73.7550, ARRAY['412115']::text[], '{}'::text[]),
	('PUN', 174, 'Bhukum', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5050, 73.7300, ARRAY['412115']::text[], '{}'::text[]),
	('PUN', 175, 'Lavale', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5300, 73.7100, ARRAY['412115']::text[], '{}'::text[]),
	('PUN', 176, 'Nande', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5450, 73.7200, ARRAY['412115']::text[], '{}'::text[]),
	('PUN', 177, 'Paud', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-47', 18.5250, 73.6150, ARRAY['412108']::text[], '{}'::text[]),
	('PUN', 178, 'Chakan', 'Outskirts', 'Chakan Municipal Council', 'Auto & industrial hub', 'GKZ-PUN-49', 18.7600, 73.8600, ARRAY['410501']::text[], '{}'::text[]),
	('PUN', 179, 'Talegaon Dabhade', 'Outskirts', 'Talegaon Dabhade Municipal Council', NULL, 'GKZ-PUN-48', 18.7350, 73.6750, ARRAY['410506']::text[], '{}'::text[]),
	('PUN', 180, 'Alandi', 'Outskirts', 'Alandi Municipal Council', 'Pilgrimage town', 'GKZ-PUN-49', 18.6770, 73.8970, ARRAY['412105']::text[], '{}'::text[]),
	('PUN', 181, 'Dehu', 'Outskirts', 'Dehu Nagar Panchayat', 'Pilgrimage town', 'GKZ-PUN-48', 18.7180, 73.7660, ARRAY['412109']::text[], '{}'::text[]),
	('PUN', 182, 'Dehu Road', 'Outskirts', 'Dehu Road Cantonment Board', NULL, 'GKZ-PUN-48', 18.6800, 73.7300, ARRAY['412101']::text[], '{}'::text[]),
	('PUN', 183, 'Lonikand', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-20', 18.6300, 74.0200, ARRAY['412216']::text[], '{}'::text[]),
	('PUN', 184, 'Kesnand', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-20', 18.6050, 74.0100, ARRAY['412207']::text[], '{}'::text[]),
	('PUN', 185, 'Koregaon Bhima', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, NULL, 18.6450, 74.0600, ARRAY['412216']::text[], '{}'::text[]),
	('PUN', 186, 'Sanaswadi', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, NULL, 18.6600, 74.1000, ARRAY['412208']::text[], '{}'::text[]),
	('PUN', 187, 'Shikrapur', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, NULL, 18.6950, 74.1350, ARRAY['412208']::text[], '{}'::text[]),
	('PUN', 188, 'Ranjangaon', 'Outskirts', 'Gram Panchayat (PMRDA area)', 'Ranjangaon MIDC', NULL, 18.7600, 74.2500, ARRAY['412220']::text[], '{}'::text[]),
	('PUN', 189, 'Loni Kalbhor', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-50', 18.4870, 74.0200, ARRAY['412201']::text[], '{}'::text[]),
	('PUN', 190, 'Theur', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-50', 18.5200, 74.0500, ARRAY['412110']::text[], '{}'::text[]),
	('PUN', 191, 'Uruli Kanchan', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, 'GKZ-PUN-50', 18.4800, 74.1400, ARRAY['412202']::text[], '{}'::text[]),
	('PUN', 192, 'Fursungi', 'Outskirts', 'Fursungi–Uruli Devachi Municipal Council', 'Separated from PMC', 'GKZ-PUN-27', 18.4800, 73.9600, ARRAY['412308']::text[], '{}'::text[]),
	('PUN', 193, 'Uruli Devachi', 'Outskirts', 'Fursungi–Uruli Devachi Municipal Council', 'Separated from PMC', 'GKZ-PUN-27', 18.4650, 73.9500, ARRAY['412308']::text[], '{}'::text[]),
	('PUN', 194, 'Saswad', 'Outskirts', 'Saswad Municipal Council', NULL, NULL, 18.3450, 74.0300, ARRAY['412301']::text[], '{}'::text[]),
	('PUN', 195, 'Khed Shivapur', 'Outskirts', 'Gram Panchayat (PMRDA area)', NULL, NULL, 18.3750, 73.8600, ARRAY['412205']::text[], '{}'::text[]),
	('PUN', 196, 'Rajgurunagar (Khed)', 'Outskirts', 'Rajgurunagar Municipal Council', NULL, NULL, 18.8600, 73.8900, ARRAY['410505']::text[], '{}'::text[])
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Provisional business index (average 99.4) and the tier / fee it gives (§5.3), all marked provisional.
INSERT INTO "franchise_zone_business" ("zone_id", "batch_id", "metric", "value", "source", "as_of", "provisional", "status", "published_at")
SELECT v.zone_id, '8a6f3c2e-0b1d-4c5e-9f7a-21b0c0de0157'::uuid, 'INDEX', v.value, 'Provisional estimate', DATE '2026-11-21', true, 'PUBLISHED', now()
FROM (VALUES
	('GKZ-PUN-01', 120),
	('GKZ-PUN-02', 150),
	('GKZ-PUN-03', 150),
	('GKZ-PUN-04', 140),
	('GKZ-PUN-05', 145),
	('GKZ-PUN-06', 130),
	('GKZ-PUN-07', 105),
	('GKZ-PUN-08', 80),
	('GKZ-PUN-09', 75),
	('GKZ-PUN-10', 130),
	('GKZ-PUN-11', 115),
	('GKZ-PUN-12', 70),
	('GKZ-PUN-13', 85),
	('GKZ-PUN-14', 90),
	('GKZ-PUN-15', 70),
	('GKZ-PUN-16', 135),
	('GKZ-PUN-17', 130),
	('GKZ-PUN-18', 95),
	('GKZ-PUN-19', 120),
	('GKZ-PUN-20', 85),
	('GKZ-PUN-21', 130),
	('GKZ-PUN-22', 110),
	('GKZ-PUN-23', 65),
	('GKZ-PUN-24', 95),
	('GKZ-PUN-25', 105),
	('GKZ-PUN-26', 70),
	('GKZ-PUN-27', 60),
	('GKZ-PUN-28', 95),
	('GKZ-PUN-29', 95),
	('GKZ-PUN-30', 90),
	('GKZ-PUN-31', 70),
	('GKZ-PUN-32', 105),
	('GKZ-PUN-33', 80),
	('GKZ-PUN-34', 65),
	('GKZ-PUN-35', 135),
	('GKZ-PUN-36', 125),
	('GKZ-PUN-37', 110),
	('GKZ-PUN-38', 120),
	('GKZ-PUN-39', 80),
	('GKZ-PUN-40', 65),
	('GKZ-PUN-41', 120),
	('GKZ-PUN-42', 90),
	('GKZ-PUN-43', 85),
	('GKZ-PUN-44', 110),
	('GKZ-PUN-45', 90),
	('GKZ-PUN-46', 115),
	('GKZ-PUN-47', 50),
	('GKZ-PUN-48', 70),
	('GKZ-PUN-49', 95),
	('GKZ-PUN-50', 55)
) AS v(zone_id, value)
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_business" b WHERE b.zone_id = v.zone_id);
--> statement-breakpoint
INSERT INTO "franchise_zone_fee_versions" ("zone_id", "business_id", "tier", "value", "average", "diff_bp", "fee_paise", "reason", "provisional")
SELECT v.zone_id, b.id, v.tier, v.value, 99.4, v.diff_bp, v.fee, v.reason, true
FROM (VALUES
	('GKZ-PUN-01', 'PREMIER', 120, 2072, 18100000, 'Dense old-city retail peths'),
	('GKZ-PUN-02', 'PREMIER', 150, 5091, 22600000, 'Wholesale trade peths (Raviwar, Budhwar, Ganj)'),
	('GKZ-PUN-03', 'PREMIER', 150, 5091, 22600000, 'FC/JM Road high street, education hub'),
	('GKZ-PUN-04', 'PREMIER', 140, 4085, 21100000, 'APMC wholesale market, transport hub'),
	('GKZ-PUN-05', 'PREMIER', 145, 4588, 21900000, 'MG Road retail, railway station'),
	('GKZ-PUN-06', 'PREMIER', 130, 3078, 19600000, 'Large affluent residential market'),
	('GKZ-PUN-07', 'STANDARD', 105, 563, 15000000, 'Established residential'),
	('GKZ-PUN-08', 'EMERGING', 80, -1952, 12100000, 'Growing residential, newer merged areas'),
	('GKZ-PUN-09', 'EMERGING', 75, -2455, 11300000, 'Newer residential, low shop density'),
	('GKZ-PUN-10', 'PREMIER', 130, 3078, 19600000, 'IT offices and high street'),
	('GKZ-PUN-11', 'PREMIER', 115, 1569, 17400000, 'Affluent residential, university area'),
	('GKZ-PUN-12', 'EMERGING', 70, -2958, 10600000, 'Cantonment, limited retail'),
	('GKZ-PUN-13', 'EMERGING', 85, -1449, 12800000, 'Mixed residential'),
	('GKZ-PUN-14', 'STANDARD', 90, -946, 15000000, 'Growing residential'),
	('GKZ-PUN-15', 'EMERGING', 70, -2958, 10600000, 'Airport area, lower shop density'),
	('GKZ-PUN-16', 'PREMIER', 135, 3581, 20400000, 'Premium residential and malls'),
	('GKZ-PUN-17', 'PREMIER', 130, 3078, 19600000, 'Premium residential, dining'),
	('GKZ-PUN-18', 'STANDARD', 95, -443, 15000000, 'Established residential'),
	('GKZ-PUN-19', 'PREMIER', 120, 2072, 18100000, 'IT hub (EON IT Park)'),
	('GKZ-PUN-20', 'EMERGING', 85, -1449, 12800000, 'Fast-growing fringe'),
	('GKZ-PUN-21', 'PREMIER', 130, 3078, 19600000, 'Large population and market'),
	('GKZ-PUN-22', 'PREMIER', 110, 1066, 16600000, 'IT townships'),
	('GKZ-PUN-23', 'EMERGING', 65, -3461, 9800000, 'Newly merged, developing'),
	('GKZ-PUN-24', 'STANDARD', 95, -443, 15000000, 'Established residential'),
	('GKZ-PUN-25', 'STANDARD', 105, 563, 15000000, 'Dense residential'),
	('GKZ-PUN-26', 'EMERGING', 70, -2958, 10600000, 'Newly merged, developing'),
	('GKZ-PUN-27', 'EMERGING', 60, -3964, 9100000, 'Peri-urban council area'),
	('GKZ-PUN-28', 'STANDARD', 95, -443, 15000000, 'Established residential'),
	('GKZ-PUN-29', 'STANDARD', 95, -443, 15000000, 'Established residential'),
	('GKZ-PUN-30', 'STANDARD', 90, -946, 15000000, 'Residential, highway trade'),
	('GKZ-PUN-31', 'EMERGING', 70, -2958, 10600000, 'Newly merged, developing'),
	('GKZ-PUN-32', 'STANDARD', 105, 563, 15000000, 'Dense residential corridor'),
	('GKZ-PUN-33', 'EMERGING', 80, -1952, 12100000, 'Growing residential'),
	('GKZ-PUN-34', 'EMERGING', 65, -3461, 9800000, 'Township and newly merged villages'),
	('GKZ-PUN-35', 'PREMIER', 135, 3581, 20400000, 'Pimpri market, PCMC trade centre'),
	('GKZ-PUN-36', 'PREMIER', 125, 2575, 18900000, 'Established commercial'),
	('GKZ-PUN-37', 'PREMIER', 110, 1066, 16600000, 'Planned residential (Pradhikaran)'),
	('GKZ-PUN-38', 'PREMIER', 120, 2072, 18100000, 'MIDC industrial area'),
	('GKZ-PUN-39', 'EMERGING', 80, -1952, 12100000, 'Growing residential'),
	('GKZ-PUN-40', 'EMERGING', 65, -3461, 9800000, 'Developing fringe'),
	('GKZ-PUN-41', 'PREMIER', 120, 2072, 18100000, 'IT-linked premium residential'),
	('GKZ-PUN-42', 'STANDARD', 90, -946, 15000000, 'Dense residential'),
	('GKZ-PUN-43', 'EMERGING', 85, -1449, 12800000, 'Fast-growing residential'),
	('GKZ-PUN-44', 'PREMIER', 110, 1066, 16600000, 'Affluent residential, high street'),
	('GKZ-PUN-45', 'STANDARD', 90, -946, 15000000, 'Established residential'),
	('GKZ-PUN-46', 'PREMIER', 115, 1569, 17400000, 'Rajiv Gandhi Infotech Park'),
	('GKZ-PUN-47', 'EMERGING', 50, -4970, 7500000, 'Rural-fringe villages'),
	('GKZ-PUN-48', 'EMERGING', 70, -2958, 10600000, 'Cantonment and council towns'),
	('GKZ-PUN-49', 'STANDARD', 95, -443, 15000000, 'Auto/industrial hub, pilgrimage town'),
	('GKZ-PUN-50', 'EMERGING', 55, -4467, 8300000, 'Rural-fringe villages')
) AS v(zone_id, tier, value, diff_bp, fee, reason)
JOIN "franchise_zone_business" b ON b.zone_id = v.zone_id AND b.status = 'PUBLISHED'
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_fee_versions" f WHERE f.zone_id = v.zone_id);
--> statement-breakpoint
-- Zone set MUM (Mumbai (Konkan)): 38 zones, 122 areas.
INSERT INTO "franchise_zone_sets" ("code", "name", "state") VALUES ('MUM', 'Mumbai (Konkan)', 'Maharashtra') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zones" ("zone_id", "zone_set_code", "cluster_no", "name", "region", "civic_body", "reason", "status", "status_reason") VALUES
	('GKZ-MUM-01', 'MUM', 1, 'Colaba–Cuffe Parade', 'Mumbai City', 'BMC', 'South Mumbai retail, tourism and offices', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-02', 'MUM', 2, 'Fort–Churchgate', 'Mumbai City', 'BMC', 'Business district, offices and high street', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-03', 'MUM', 3, 'Kalbadevi–Girgaon', 'Mumbai City', 'BMC', 'Wholesale markets (Crawford, Zaveri Bazaar), dense retail', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-04', 'MUM', 4, 'Byculla–Mazgaon', 'Mumbai City', 'BMC', 'Mixed residential and trading, docks', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-05', 'MUM', 5, 'Malabar Hill–Grant Road', 'Mumbai City', 'BMC', 'Premium residential, Grant Road retail', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-06', 'MUM', 6, 'Worli–Lower Parel', 'Mumbai City', 'BMC', 'Offices, malls and premium residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-07', 'MUM', 7, 'Dadar–Matunga', 'Mumbai City', 'BMC', 'Central markets (Dadar), dense residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-08', 'MUM', 8, 'Sion–Dharavi', 'Mumbai City', 'BMC', 'Small industry and trading, dense residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-09', 'MUM', 9, 'Bandra–Khar', 'Mumbai Suburban West', 'BMC', 'High street, BKC offices, affluent residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-10', 'MUM', 10, 'Santacruz–Vile Parle', 'Mumbai Suburban West', 'BMC', 'Airport area, residential and retail', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-11', 'MUM', 11, 'Andheri West–Versova', 'Mumbai Suburban West', 'BMC', 'Dense residential, media and retail', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-12', 'MUM', 12, 'Andheri East–Marol', 'Mumbai Suburban West', 'BMC', 'Offices, MIDC and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-13', 'MUM', 13, 'Jogeshwari–Goregaon', 'Mumbai Suburban West', 'BMC', 'Residential, film city and offices', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-14', 'MUM', 14, 'Malad', 'Mumbai Suburban West', 'BMC', 'Large residential market, malls', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-15', 'MUM', 15, 'Kandivali', 'Mumbai Suburban West', 'BMC', 'Large residential market', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-16', 'MUM', 16, 'Borivali–Dahisar', 'Mumbai Suburban West', 'BMC', 'Large residential market, northern suburbs', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-17', 'MUM', 17, 'Kurla–Chembur', 'Mumbai Suburban East', 'BMC', 'Trading, transport hub and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-18', 'MUM', 18, 'Ghatkopar–Vikhroli', 'Mumbai Suburban East', 'BMC', 'Retail high streets, offices and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-19', 'MUM', 19, 'Powai–Bhandup', 'Mumbai Suburban East', 'BMC', 'IT offices, premium and mid residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-20', 'MUM', 20, 'Mulund', 'Mumbai Suburban East', 'BMC', 'Established residential market', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-21', 'MUM', 21, 'Govandi–Mankhurd', 'Mumbai Suburban East', 'BMC', 'Developing residential, harbour line', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-22', 'MUM', 22, 'Thane City', 'Thane', 'TMC', 'Dense retail and residential, district centre', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-23', 'MUM', 23, 'Ghodbunder Road', 'Thane', 'TMC', 'Fast-growing premium residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-24', 'MUM', 24, 'Kalwa–Mumbra', 'Thane', 'TMC', 'Dense residential, developing', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-25', 'MUM', 25, 'Kalyan–Dombivli', 'Thane', 'KDMC', 'Large residential twin city, markets', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-26', 'MUM', 26, 'Ulhasnagar–Ambernath–Badlapur', 'Thane', 'Municipal Councils', 'Trading town and growing suburbs', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-27', 'MUM', 27, 'Bhiwandi', 'Thane', 'BNMC', 'Warehousing and textile trade', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-28', 'MUM', 28, 'Mira–Bhayandar', 'Thane', 'MBMC', 'Large residential market', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-29', 'MUM', 29, 'Vashi–Sanpada', 'Navi Mumbai', 'NMMC', 'APMC market, retail and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-30', 'MUM', 30, 'Nerul–Belapur', 'Navi Mumbai', 'NMMC', 'Residential and CBD offices', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-31', 'MUM', 31, 'Airoli–Ghansoli', 'Navi Mumbai', 'NMMC', 'IT parks and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-32', 'MUM', 32, 'Kharghar–Panvel', 'Navi Mumbai', 'NMMC / PMC (Panvel)', 'Fast-growing residential, new airport belt', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-33', 'MUM', 33, 'Vasai–Virar', 'Palghar', 'VVMC', 'Large and growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-34', 'MUM', 34, 'Palghar–Boisar', 'Palghar', 'Municipal Councils', 'Industrial (Tarapur MIDC) and district towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-35', 'MUM', 35, 'Alibag–Pen–Uran', 'Raigad', 'Municipal Councils', 'Coastal towns, port (JNPT) and tourism', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-36', 'MUM', 36, 'Khopoli–Karjat', 'Raigad', 'Municipal Councils', 'Industrial and hill towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-37', 'MUM', 37, 'Ratnagiri–Chiplun', 'Ratnagiri', 'Municipal Councils', 'District towns, Konkan coast', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-MUM-38', 'MUM', 38, 'Sindhudurg', 'Sindhudurg', 'Municipal Councils', 'District towns, tourism', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_areas" ("zone_set_code", "area_no", "name", "region", "civic_body", "notes", "zone_id", "lat", "lng", "pincodes", "aliases") VALUES
	('MUM', 1, 'Colaba', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-01', 18.9067, 72.8147, ARRAY['400005']::text[], '{}'::text[]),
	('MUM', 2, 'Cuffe Parade', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-01', 18.9150, 72.8200, ARRAY['400005']::text[], '{}'::text[]),
	('MUM', 3, 'Navy Nagar', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-01', 18.8990, 72.8110, ARRAY['400005']::text[], '{}'::text[]),
	('MUM', 4, 'Fort', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-02', 18.9340, 72.8360, ARRAY['400001']::text[], '{}'::text[]),
	('MUM', 5, 'Churchgate', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-02', 18.9322, 72.8264, ARRAY['400020']::text[], '{}'::text[]),
	('MUM', 6, 'Nariman Point', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-02', 18.9256, 72.8242, ARRAY['400021']::text[], '{}'::text[]),
	('MUM', 7, 'Ballard Estate', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-02', 18.9400, 72.8400, ARRAY['400001']::text[], '{}'::text[]),
	('MUM', 8, 'Kalbadevi', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-03', 18.9490, 72.8300, ARRAY['400002']::text[], '{}'::text[]),
	('MUM', 9, 'Girgaon', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-03', 18.9550, 72.8170, ARRAY['400004']::text[], '{}'::text[]),
	('MUM', 10, 'Marine Lines', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-03', 18.9450, 72.8230, ARRAY['400002']::text[], '{}'::text[]),
	('MUM', 11, 'Crawford Market', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-03', 18.9470, 72.8340, ARRAY['400001']::text[], '{}'::text[]),
	('MUM', 12, 'Byculla', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-04', 18.9760, 72.8330, ARRAY['400027']::text[], '{}'::text[]),
	('MUM', 13, 'Mazgaon', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-04', 18.9640, 72.8440, ARRAY['400010']::text[], '{}'::text[]),
	('MUM', 14, 'Nagpada', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-04', 18.9690, 72.8270, ARRAY['400008']::text[], '{}'::text[]),
	('MUM', 15, 'Mumbai Central', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-04', 18.9690, 72.8190, ARRAY['400008']::text[], '{}'::text[]),
	('MUM', 16, 'Malabar Hill', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-05', 18.9548, 72.7985, ARRAY['400006']::text[], '{}'::text[]),
	('MUM', 17, 'Walkeshwar', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-05', 18.9480, 72.7950, ARRAY['400006']::text[], '{}'::text[]),
	('MUM', 18, 'Grant Road', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-05', 18.9630, 72.8160, ARRAY['400007']::text[], '{}'::text[]),
	('MUM', 19, 'Tardeo', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-05', 18.9690, 72.8120, ARRAY['400034']::text[], '{}'::text[]),
	('MUM', 20, 'Worli', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-06', 19.0176, 72.8162, ARRAY['400018']::text[], '{}'::text[]),
	('MUM', 21, 'Lower Parel', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-06', 18.9950, 72.8300, ARRAY['400013']::text[], '{}'::text[]),
	('MUM', 22, 'Prabhadevi', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-06', 19.0160, 72.8290, ARRAY['400025']::text[], '{}'::text[]),
	('MUM', 23, 'Mahalaxmi', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-06', 18.9820, 72.8240, ARRAY['400011']::text[], '{}'::text[]),
	('MUM', 24, 'Dadar', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-07', 19.0178, 72.8478, ARRAY['400014']::text[], '{}'::text[]),
	('MUM', 25, 'Matunga', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-07', 19.0270, 72.8550, ARRAY['400019']::text[], '{}'::text[]),
	('MUM', 26, 'Mahim', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-07', 19.0390, 72.8410, ARRAY['400016']::text[], '{}'::text[]),
	('MUM', 27, 'Wadala', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-07', 19.0160, 72.8650, ARRAY['400031']::text[], '{}'::text[]),
	('MUM', 28, 'Sion', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-08', 19.0390, 72.8620, ARRAY['400022']::text[], '{}'::text[]),
	('MUM', 29, 'Dharavi', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-08', 19.0430, 72.8540, ARRAY['400017']::text[], '{}'::text[]),
	('MUM', 30, 'Antop Hill', 'Mumbai City', 'BMC', NULL, 'GKZ-MUM-08', 19.0240, 72.8650, ARRAY['400037']::text[], '{}'::text[]),
	('MUM', 31, 'Bandra West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-09', 19.0596, 72.8295, ARRAY['400050']::text[], '{}'::text[]),
	('MUM', 32, 'Bandra East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-09', 19.0600, 72.8480, ARRAY['400051']::text[], '{}'::text[]),
	('MUM', 33, 'Khar', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-09', 19.0700, 72.8370, ARRAY['400052']::text[], '{}'::text[]),
	('MUM', 34, 'Santacruz', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-10', 19.0810, 72.8410, ARRAY['400054']::text[], '{}'::text[]),
	('MUM', 35, 'Vile Parle', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-10', 19.0990, 72.8440, ARRAY['400057']::text[], '{}'::text[]),
	('MUM', 36, 'Juhu', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-10', 19.1070, 72.8260, ARRAY['400049']::text[], '{}'::text[]),
	('MUM', 37, 'Andheri West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-11', 19.1360, 72.8270, ARRAY['400053']::text[], '{}'::text[]),
	('MUM', 38, 'Versova', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-11', 19.1310, 72.8150, ARRAY['400061']::text[], '{}'::text[]),
	('MUM', 39, 'Lokhandwala', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-11', 19.1420, 72.8250, ARRAY['400053']::text[], '{}'::text[]),
	('MUM', 40, 'Oshiwara', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-11', 19.1500, 72.8350, ARRAY['400102']::text[], '{}'::text[]),
	('MUM', 41, 'Andheri East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-12', 19.1150, 72.8700, ARRAY['400069']::text[], '{}'::text[]),
	('MUM', 42, 'Marol', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-12', 19.1190, 72.8830, ARRAY['400059']::text[], '{}'::text[]),
	('MUM', 43, 'Chakala', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-12', 19.1110, 72.8650, ARRAY['400099']::text[], '{}'::text[]),
	('MUM', 44, 'Saki Naka', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-12', 19.1030, 72.8880, ARRAY['400072']::text[], '{}'::text[]),
	('MUM', 45, 'Jogeshwari', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-13', 19.1350, 72.8490, ARRAY['400060']::text[], '{}'::text[]),
	('MUM', 46, 'Goregaon West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-13', 19.1640, 72.8430, ARRAY['400062']::text[], '{}'::text[]),
	('MUM', 47, 'Goregaon East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-13', 19.1630, 72.8580, ARRAY['400063']::text[], '{}'::text[]),
	('MUM', 48, 'Malad West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-14', 19.1870, 72.8350, ARRAY['400064']::text[], '{}'::text[]),
	('MUM', 49, 'Malad East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-14', 19.1860, 72.8590, ARRAY['400097']::text[], '{}'::text[]),
	('MUM', 50, 'Kandivali West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-15', 19.2050, 72.8400, ARRAY['400067']::text[], '{}'::text[]),
	('MUM', 51, 'Kandivali East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-15', 19.2060, 72.8670, ARRAY['400101']::text[], '{}'::text[]),
	('MUM', 52, 'Borivali West', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-16', 19.2310, 72.8500, ARRAY['400092']::text[], '{}'::text[]),
	('MUM', 53, 'Borivali East', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-16', 19.2290, 72.8640, ARRAY['400066']::text[], '{}'::text[]),
	('MUM', 54, 'Dahisar', 'Mumbai Suburban West', 'BMC', NULL, 'GKZ-MUM-16', 19.2500, 72.8590, ARRAY['400068']::text[], '{}'::text[]),
	('MUM', 55, 'Kurla', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-17', 19.0700, 72.8790, ARRAY['400070']::text[], '{}'::text[]),
	('MUM', 56, 'Chembur', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-17', 19.0620, 72.9000, ARRAY['400071']::text[], '{}'::text[]),
	('MUM', 57, 'Chunabhatti', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-17', 19.0510, 72.8730, ARRAY['400022']::text[], '{}'::text[]),
	('MUM', 58, 'Tilak Nagar', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-17', 19.0670, 72.8930, ARRAY['400089']::text[], '{}'::text[]),
	('MUM', 59, 'Ghatkopar', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-18', 19.0860, 72.9080, ARRAY['400077']::text[], '{}'::text[]),
	('MUM', 60, 'Vikhroli', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-18', 19.1110, 72.9280, ARRAY['400079']::text[], '{}'::text[]),
	('MUM', 61, 'Kanjurmarg', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-18', 19.1290, 72.9310, ARRAY['400042']::text[], '{}'::text[]),
	('MUM', 62, 'Powai', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-19', 19.1176, 72.9060, ARRAY['400076']::text[], '{}'::text[]),
	('MUM', 63, 'Bhandup', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-19', 19.1430, 72.9370, ARRAY['400078']::text[], '{}'::text[]),
	('MUM', 64, 'Nahur', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-19', 19.1550, 72.9460, ARRAY['400078']::text[], '{}'::text[]),
	('MUM', 65, 'Mulund West', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-20', 19.1720, 72.9560, ARRAY['400080']::text[], '{}'::text[]),
	('MUM', 66, 'Mulund East', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-20', 19.1700, 72.9640, ARRAY['400081']::text[], '{}'::text[]),
	('MUM', 67, 'Govandi', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-21', 19.0550, 72.9150, ARRAY['400043']::text[], '{}'::text[]),
	('MUM', 68, 'Mankhurd', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-21', 19.0480, 72.9320, ARRAY['400088']::text[], '{}'::text[]),
	('MUM', 69, 'Trombay', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-21', 19.0060, 72.9330, ARRAY['400088']::text[], '{}'::text[]),
	('MUM', 70, 'Deonar', 'Mumbai Suburban East', 'BMC', NULL, 'GKZ-MUM-21', 19.0490, 72.9120, ARRAY['400088']::text[], '{}'::text[]),
	('MUM', 71, 'Thane West', 'Thane', 'TMC', NULL, 'GKZ-MUM-22', 19.1970, 72.9640, ARRAY['400601']::text[], '{}'::text[]),
	('MUM', 72, 'Naupada', 'Thane', 'TMC', NULL, 'GKZ-MUM-22', 19.1920, 72.9730, ARRAY['400602']::text[], '{}'::text[]),
	('MUM', 73, 'Majiwada', 'Thane', 'TMC', NULL, 'GKZ-MUM-22', 19.2240, 72.9810, ARRAY['400601']::text[], '{}'::text[]),
	('MUM', 74, 'Kopri', 'Thane', 'TMC', NULL, 'GKZ-MUM-22', 19.1890, 72.9850, ARRAY['400603']::text[], '{}'::text[]),
	('MUM', 75, 'Ghodbunder Road', 'Thane', 'TMC', NULL, 'GKZ-MUM-23', 19.2580, 72.9670, ARRAY['400615']::text[], '{}'::text[]),
	('MUM', 76, 'Kasarvadavali', 'Thane', 'TMC', NULL, 'GKZ-MUM-23', 19.2720, 72.9700, ARRAY['400615']::text[], '{}'::text[]),
	('MUM', 77, 'Manpada', 'Thane', 'TMC', NULL, 'GKZ-MUM-23', 19.2350, 72.9750, ARRAY['400607']::text[], '{}'::text[]),
	('MUM', 78, 'Kalwa', 'Thane', 'TMC', NULL, 'GKZ-MUM-24', 19.2010, 72.9970, ARRAY['400605']::text[], '{}'::text[]),
	('MUM', 79, 'Mumbra', 'Thane', 'TMC', NULL, 'GKZ-MUM-24', 19.1750, 73.0230, ARRAY['400612']::text[], '{}'::text[]),
	('MUM', 80, 'Diva', 'Thane', 'TMC', NULL, 'GKZ-MUM-24', 19.1900, 73.0430, ARRAY['400612']::text[], '{}'::text[]),
	('MUM', 81, 'Kalyan', 'Thane', 'KDMC', NULL, 'GKZ-MUM-25', 19.2437, 73.1355, ARRAY['421301']::text[], '{}'::text[]),
	('MUM', 82, 'Dombivli', 'Thane', 'KDMC', NULL, 'GKZ-MUM-25', 19.2180, 73.0870, ARRAY['421201']::text[], '{}'::text[]),
	('MUM', 83, 'Thakurli', 'Thane', 'KDMC', NULL, 'GKZ-MUM-25', 19.2260, 73.0980, ARRAY['421201']::text[], '{}'::text[]),
	('MUM', 84, 'Ulhasnagar', 'Thane', 'Municipal Councils', NULL, 'GKZ-MUM-26', 19.2180, 73.1630, ARRAY['421003']::text[], '{}'::text[]),
	('MUM', 85, 'Ambernath', 'Thane', 'Municipal Councils', NULL, 'GKZ-MUM-26', 19.2010, 73.1870, ARRAY['421501']::text[], '{}'::text[]),
	('MUM', 86, 'Badlapur', 'Thane', 'Municipal Councils', NULL, 'GKZ-MUM-26', 19.1550, 73.2650, ARRAY['421503']::text[], '{}'::text[]),
	('MUM', 87, 'Bhiwandi', 'Thane', 'BNMC', NULL, 'GKZ-MUM-27', 19.2960, 73.0630, ARRAY['421302']::text[], '{}'::text[]),
	('MUM', 88, 'Mira Road', 'Thane', 'MBMC', NULL, 'GKZ-MUM-28', 19.2810, 72.8690, ARRAY['401107']::text[], '{}'::text[]),
	('MUM', 89, 'Bhayandar', 'Thane', 'MBMC', NULL, 'GKZ-MUM-28', 19.3010, 72.8510, ARRAY['401101']::text[], '{}'::text[]),
	('MUM', 90, 'Vashi', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-29', 19.0770, 72.9990, ARRAY['400703']::text[], '{}'::text[]),
	('MUM', 91, 'Sanpada', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-29', 19.0630, 73.0110, ARRAY['400705']::text[], '{}'::text[]),
	('MUM', 92, 'Turbhe', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-29', 19.0760, 73.0170, ARRAY['400705']::text[], '{}'::text[]),
	('MUM', 93, 'Koparkhairane', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-29', 19.1030, 73.0100, ARRAY['400709']::text[], '{}'::text[]),
	('MUM', 94, 'Nerul', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-30', 19.0330, 73.0190, ARRAY['400706']::text[], '{}'::text[]),
	('MUM', 95, 'CBD Belapur', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-30', 19.0230, 73.0390, ARRAY['400614']::text[], '{}'::text[]),
	('MUM', 96, 'Seawoods', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-30', 19.0200, 73.0190, ARRAY['400706']::text[], '{}'::text[]),
	('MUM', 97, 'Airoli', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-31', 19.1590, 72.9990, ARRAY['400708']::text[], '{}'::text[]),
	('MUM', 98, 'Ghansoli', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-31', 19.1170, 73.0040, ARRAY['400701']::text[], '{}'::text[]),
	('MUM', 99, 'Rabale', 'Navi Mumbai', 'NMMC', NULL, 'GKZ-MUM-31', 19.1400, 73.0050, ARRAY['400701']::text[], '{}'::text[]),
	('MUM', 100, 'Kharghar', 'Navi Mumbai', 'NMMC / PMC (Panvel)', NULL, 'GKZ-MUM-32', 19.0470, 73.0700, ARRAY['410210']::text[], '{}'::text[]),
	('MUM', 101, 'Kamothe', 'Navi Mumbai', 'NMMC / PMC (Panvel)', NULL, 'GKZ-MUM-32', 19.0210, 73.0950, ARRAY['410209']::text[], '{}'::text[]),
	('MUM', 102, 'Panvel', 'Navi Mumbai', 'NMMC / PMC (Panvel)', NULL, 'GKZ-MUM-32', 18.9894, 73.1175, ARRAY['410206']::text[], '{}'::text[]),
	('MUM', 103, 'Kalamboli', 'Navi Mumbai', 'NMMC / PMC (Panvel)', NULL, 'GKZ-MUM-32', 19.0300, 73.1010, ARRAY['410218']::text[], '{}'::text[]),
	('MUM', 104, 'Vasai', 'Palghar', 'VVMC', NULL, 'GKZ-MUM-33', 19.3910, 72.8390, ARRAY['401202']::text[], '{}'::text[]),
	('MUM', 105, 'Nalasopara', 'Palghar', 'VVMC', NULL, 'GKZ-MUM-33', 19.4180, 72.8190, ARRAY['401203']::text[], '{}'::text[]),
	('MUM', 106, 'Virar', 'Palghar', 'VVMC', NULL, 'GKZ-MUM-33', 19.4560, 72.8120, ARRAY['401303']::text[], '{}'::text[]),
	('MUM', 107, 'Palghar', 'Palghar', 'Municipal Councils', NULL, 'GKZ-MUM-34', 19.6970, 72.7650, ARRAY['401404']::text[], '{}'::text[]),
	('MUM', 108, 'Boisar', 'Palghar', 'Municipal Councils', NULL, 'GKZ-MUM-34', 19.8030, 72.7550, ARRAY['401501']::text[], '{}'::text[]),
	('MUM', 109, 'Dahanu', 'Palghar', 'Municipal Councils', NULL, 'GKZ-MUM-34', 19.9750, 72.7330, ARRAY['401601']::text[], '{}'::text[]),
	('MUM', 110, 'Alibag', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-35', 18.6414, 72.8722, ARRAY['402201']::text[], '{}'::text[]),
	('MUM', 111, 'Pen', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-35', 18.7370, 73.0960, ARRAY['402107']::text[], '{}'::text[]),
	('MUM', 112, 'Uran', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-35', 18.8780, 72.9390, ARRAY['400702']::text[], '{}'::text[]),
	('MUM', 113, 'Khopoli', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-36', 18.7860, 73.3450, ARRAY['410203']::text[], '{}'::text[]),
	('MUM', 114, 'Karjat', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-36', 18.9100, 73.3230, ARRAY['410201']::text[], '{}'::text[]),
	('MUM', 115, 'Khalapur', 'Raigad', 'Municipal Councils', NULL, 'GKZ-MUM-36', 18.8270, 73.2810, ARRAY['410202']::text[], '{}'::text[]),
	('MUM', 116, 'Ratnagiri', 'Ratnagiri', 'Municipal Councils', NULL, 'GKZ-MUM-37', 16.9902, 73.3120, ARRAY['415612']::text[], '{}'::text[]),
	('MUM', 117, 'Chiplun', 'Ratnagiri', 'Municipal Councils', NULL, 'GKZ-MUM-37', 17.5310, 73.5150, ARRAY['415605']::text[], '{}'::text[]),
	('MUM', 118, 'Dapoli', 'Ratnagiri', 'Municipal Councils', NULL, 'GKZ-MUM-37', 17.7590, 73.1860, ARRAY['415712']::text[], '{}'::text[]),
	('MUM', 119, 'Kudal', 'Sindhudurg', 'Municipal Councils', NULL, 'GKZ-MUM-38', 16.0100, 73.6890, ARRAY['416520']::text[], '{}'::text[]),
	('MUM', 120, 'Sawantwadi', 'Sindhudurg', 'Municipal Councils', NULL, 'GKZ-MUM-38', 15.9050, 73.8210, ARRAY['416510']::text[], '{}'::text[]),
	('MUM', 121, 'Malvan', 'Sindhudurg', 'Municipal Councils', NULL, 'GKZ-MUM-38', 16.0590, 73.4690, ARRAY['416606']::text[], '{}'::text[]),
	('MUM', 122, 'Kankavli', 'Sindhudurg', 'Municipal Councils', NULL, 'GKZ-MUM-38', 16.2650, 73.7120, ARRAY['416602']::text[], '{}'::text[])
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zone_business" ("zone_id", "batch_id", "metric", "value", "source", "as_of", "provisional", "status", "published_at")
SELECT v.zone_id, '8a6f3c2e-0b1d-4c5e-9f7a-21b0c0dea001'::uuid, 'INDEX', 100, 'Provisional (no business data yet)', DATE '2026-11-21', true, 'PUBLISHED', now()
FROM (VALUES
	('GKZ-MUM-01'),
	('GKZ-MUM-02'),
	('GKZ-MUM-03'),
	('GKZ-MUM-04'),
	('GKZ-MUM-05'),
	('GKZ-MUM-06'),
	('GKZ-MUM-07'),
	('GKZ-MUM-08'),
	('GKZ-MUM-09'),
	('GKZ-MUM-10'),
	('GKZ-MUM-11'),
	('GKZ-MUM-12'),
	('GKZ-MUM-13'),
	('GKZ-MUM-14'),
	('GKZ-MUM-15'),
	('GKZ-MUM-16'),
	('GKZ-MUM-17'),
	('GKZ-MUM-18'),
	('GKZ-MUM-19'),
	('GKZ-MUM-20'),
	('GKZ-MUM-21'),
	('GKZ-MUM-22'),
	('GKZ-MUM-23'),
	('GKZ-MUM-24'),
	('GKZ-MUM-25'),
	('GKZ-MUM-26'),
	('GKZ-MUM-27'),
	('GKZ-MUM-28'),
	('GKZ-MUM-29'),
	('GKZ-MUM-30'),
	('GKZ-MUM-31'),
	('GKZ-MUM-32'),
	('GKZ-MUM-33'),
	('GKZ-MUM-34'),
	('GKZ-MUM-35'),
	('GKZ-MUM-36'),
	('GKZ-MUM-37'),
	('GKZ-MUM-38')
) AS v(zone_id)
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_business" b WHERE b.zone_id = v.zone_id);
--> statement-breakpoint
INSERT INTO "franchise_zone_fee_versions" ("zone_id", "business_id", "tier", "value", "average", "diff_bp", "fee_paise", "reason", "provisional")
SELECT z.zone_id, b.id, 'STANDARD', 100, 100, 0, 15000000, z.reason, true FROM "franchise_zones" z JOIN "franchise_zone_business" b ON b.zone_id = z.zone_id AND b.status = 'PUBLISHED'
WHERE z.zone_set_code = 'MUM' AND NOT EXISTS (SELECT 1 FROM "franchise_zone_fee_versions" f WHERE f.zone_id = z.zone_id);
--> statement-breakpoint
-- Zone set NSK (Nashik): 11 zones, 31 areas.
INSERT INTO "franchise_zone_sets" ("code", "name", "state") VALUES ('NSK', 'Nashik', 'Maharashtra') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zones" ("zone_id", "zone_set_code", "cluster_no", "name", "region", "civic_body", "reason", "status", "status_reason") VALUES
	('GKZ-NSK-01', 'NSK', 1, 'Old Nashik–Panchavati', 'Nashik City', 'NMC', 'Old city markets and pilgrimage centre', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-02', 'NSK', 2, 'College Road–Gangapur Road', 'Nashik City', 'NMC', 'High street, education hub, affluent residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-03', 'NSK', 3, 'Nashik Road–Deolali', 'Nashik City', 'NMC / Cantonment', 'Railway hub, cantonment and residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-04', 'NSK', 4, 'CIDCO–Ambad–Satpur', 'Nashik City', 'NMC', 'MIDC industry and large residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-05', 'NSK', 5, 'Indira Nagar–Pathardi', 'Nashik City', 'NMC', 'Growing residential', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-06', 'NSK', 6, 'Mhasrul–Adgaon', 'Nashik City', 'NMC', 'Developing fringe', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-07', 'NSK', 7, 'Malegaon', 'Malegaon', 'MMC', 'Powerloom textile trade town', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-08', 'NSK', 8, 'Sinnar–Igatpuri', 'Nashik District', 'Municipal Councils', 'MIDC (Sinnar) and hill towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-09', 'NSK', 9, 'Niphad–Ozar–Pimpalgaon', 'Nashik District', 'Municipal Councils', 'Grape and onion belt, HAL Ozar', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-10', 'NSK', 10, 'Yeola–Manmad–Nandgaon', 'Nashik District', 'Municipal Councils', 'Railway junction and trading towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review'),
	('GKZ-NSK-11', 'NSK', 11, 'Dindori–Kalwan–Satana', 'Nashik District', 'Municipal Councils', 'Agricultural market towns', 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_areas" ("zone_set_code", "area_no", "name", "region", "civic_body", "notes", "zone_id", "lat", "lng", "pincodes", "aliases") VALUES
	('NSK', 1, 'Panchavati', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-01', 20.0080, 73.7930, ARRAY['422003']::text[], '{}'::text[]),
	('NSK', 2, 'Old Nashik', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-01', 20.0030, 73.7890, ARRAY['422001']::text[], '{}'::text[]),
	('NSK', 3, 'Ravivar Karanja', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-01', 20.0010, 73.7850, ARRAY['422001']::text[], '{}'::text[]),
	('NSK', 4, 'College Road', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-02', 20.0050, 73.7660, ARRAY['422005']::text[], '{}'::text[]),
	('NSK', 5, 'Gangapur Road', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-02', 20.0130, 73.7550, ARRAY['422013']::text[], '{}'::text[]),
	('NSK', 6, 'Canada Corner', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-02', 20.0000, 73.7700, ARRAY['422005']::text[], '{}'::text[]),
	('NSK', 7, 'Nashik Road', 'Nashik City', 'NMC / Cantonment', NULL, 'GKZ-NSK-03', 19.9500, 73.8400, ARRAY['422101']::text[], '{}'::text[]),
	('NSK', 8, 'Deolali Camp', 'Nashik City', 'NMC / Cantonment', NULL, 'GKZ-NSK-03', 19.9450, 73.8340, ARRAY['422401']::text[], '{}'::text[]),
	('NSK', 9, 'Jail Road', 'Nashik City', 'NMC / Cantonment', NULL, 'GKZ-NSK-03', 19.9600, 73.8300, ARRAY['422101']::text[], '{}'::text[]),
	('NSK', 10, 'CIDCO Nashik', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-04', 19.9800, 73.7550, ARRAY['422009']::text[], '{}'::text[]),
	('NSK', 11, 'Ambad', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-04', 19.9600, 73.7400, ARRAY['422010']::text[], '{}'::text[]),
	('NSK', 12, 'Satpur', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-04', 20.0080, 73.7350, ARRAY['422007']::text[], '{}'::text[]),
	('NSK', 13, 'Indira Nagar Nashik', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-05', 19.9800, 73.7820, ARRAY['422009']::text[], '{}'::text[]),
	('NSK', 14, 'Pathardi Phata', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-05', 19.9550, 73.7700, ARRAY['422010']::text[], '{}'::text[]),
	('NSK', 15, 'Rane Nagar', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-05', 19.9720, 73.7750, ARRAY['422009']::text[], '{}'::text[]),
	('NSK', 16, 'Mhasrul', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-06', 20.0400, 73.8000, ARRAY['422004']::text[], '{}'::text[]),
	('NSK', 17, 'Adgaon', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-06', 20.0300, 73.8300, ARRAY['422003']::text[], '{}'::text[]),
	('NSK', 18, 'Makhmalabad', 'Nashik City', 'NMC', NULL, 'GKZ-NSK-06', 20.0250, 73.7650, ARRAY['422003']::text[], '{}'::text[]),
	('NSK', 19, 'Malegaon', 'Malegaon', 'MMC', NULL, 'GKZ-NSK-07', 20.5579, 74.5287, ARRAY['423203']::text[], '{}'::text[]),
	('NSK', 20, 'Sinnar', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-08', 19.8460, 73.9980, ARRAY['422103']::text[], '{}'::text[]),
	('NSK', 21, 'Igatpuri', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-08', 19.6950, 73.5600, ARRAY['422403']::text[], '{}'::text[]),
	('NSK', 22, 'Ghoti', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-08', 19.7160, 73.6280, ARRAY['422402']::text[], '{}'::text[]),
	('NSK', 23, 'Niphad', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-09', 20.0800, 74.1100, ARRAY['422303']::text[], '{}'::text[]),
	('NSK', 24, 'Ozar', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-09', 20.0950, 73.9270, ARRAY['422206']::text[], '{}'::text[]),
	('NSK', 25, 'Pimpalgaon Baswant', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-09', 20.1700, 73.9900, ARRAY['422209']::text[], '{}'::text[]),
	('NSK', 26, 'Yeola', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-10', 20.0420, 74.4890, ARRAY['423401']::text[], '{}'::text[]),
	('NSK', 27, 'Manmad', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-10', 20.2510, 74.4370, ARRAY['423104']::text[], '{}'::text[]),
	('NSK', 28, 'Nandgaon', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-10', 20.3070, 74.6570, ARRAY['423106']::text[], '{}'::text[]),
	('NSK', 29, 'Dindori', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-11', 20.2040, 73.8330, ARRAY['422202']::text[], '{}'::text[]),
	('NSK', 30, 'Kalwan', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-11', 20.4950, 74.0300, ARRAY['423501']::text[], '{}'::text[]),
	('NSK', 31, 'Satana', 'Nashik District', 'Municipal Councils', NULL, 'GKZ-NSK-11', 20.5980, 74.2030, ARRAY['423301']::text[], '{}'::text[])
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "franchise_zone_business" ("zone_id", "batch_id", "metric", "value", "source", "as_of", "provisional", "status", "published_at")
SELECT v.zone_id, '8a6f3c2e-0b1d-4c5e-9f7a-21b0c0dea002'::uuid, 'INDEX', 100, 'Provisional (no business data yet)', DATE '2026-11-21', true, 'PUBLISHED', now()
FROM (VALUES
	('GKZ-NSK-01'),
	('GKZ-NSK-02'),
	('GKZ-NSK-03'),
	('GKZ-NSK-04'),
	('GKZ-NSK-05'),
	('GKZ-NSK-06'),
	('GKZ-NSK-07'),
	('GKZ-NSK-08'),
	('GKZ-NSK-09'),
	('GKZ-NSK-10'),
	('GKZ-NSK-11')
) AS v(zone_id)
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_business" b WHERE b.zone_id = v.zone_id);
--> statement-breakpoint
INSERT INTO "franchise_zone_fee_versions" ("zone_id", "business_id", "tier", "value", "average", "diff_bp", "fee_paise", "reason", "provisional")
SELECT z.zone_id, b.id, 'STANDARD', 100, 100, 0, 15000000, z.reason, true FROM "franchise_zones" z JOIN "franchise_zone_business" b ON b.zone_id = z.zone_id AND b.status = 'PUBLISHED'
WHERE z.zone_set_code = 'NSK' AND NOT EXISTS (SELECT 1 FROM "franchise_zone_fee_versions" f WHERE f.zone_id = z.zone_id);
--> statement-breakpoint
INSERT INTO "franchise_zone_status_history" ("zone_id", "old_status", "new_status", "reason", "applied_at")
SELECT z.zone_id, NULL, z.status, 'Zone created (seed, 21-Nov-2026)', now() FROM "franchise_zones" z
WHERE NOT EXISTS (SELECT 1 FROM "franchise_zone_status_history" h WHERE h.zone_id = z.zone_id);
