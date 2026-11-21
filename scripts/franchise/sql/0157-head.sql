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
