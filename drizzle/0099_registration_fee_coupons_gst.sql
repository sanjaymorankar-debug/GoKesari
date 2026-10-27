-- split: seller
-- Owner, 27 Oct 2026 (Add my shop): the one-time registration fee is the base fee
-- (Admin → Registration fee, ₹999), less a registration-fee coupon, plus GST at
-- the rate in force (Admin → Statutory, PLATFORM_FEE_GST: 18%).
--   * registration_fee_coupons — admin-managed codes (flat ₹ or % off the base).
--   * shops.registration_fee_* — how a shop's fee was made up; registration_fee_paise
--     stays the total payable. Null for shops registered before.
-- Safe to rerun.
CREATE TABLE IF NOT EXISTS "registration_fee_coupons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "description" text,
  "discount_type" text NOT NULL,
  "flat_paise" bigint,
  "percent" integer,
  "max_discount_paise" bigint,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "usage_limit" integer,
  "per_owner_limit" integer DEFAULT 1,
  "active" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "registration_fee_coupons_amount_valid" CHECK (("discount_type" = 'FLAT' AND "flat_paise" > 0) OR ("discount_type" = 'PERCENT' AND "percent" BETWEEN 1 AND 100))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "registration_fee_coupons_code_uq" ON "registration_fee_coupons" ("code");--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_base_paise" bigint;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_discount_paise" bigint;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_gst_paise" bigint;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_gst_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "registration_fee_coupon_code" text;
