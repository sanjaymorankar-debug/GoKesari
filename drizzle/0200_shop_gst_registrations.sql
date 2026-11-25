-- Many GSTINs per shop (owner, 25-Nov-2026). A shop keeps its main GSTIN on shops.gstin; a chain
-- registered in several states adds the others here after going live (any PAN, each checked with
-- the KYC vendor). An order delivered in a state where the shop has a VERIFIED extra GSTIN is
-- invoiced under it. Additive and safe to re-run; nothing existing changes. shops is not referenced
-- by foreign key (seller-side table): the service checks the link.
-- Rollback: DROP TABLE IF EXISTS "shop_gst_registrations";

CREATE TABLE IF NOT EXISTS "shop_gst_registrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shop_id" uuid NOT NULL,
  "gstin_encrypted" text NOT NULL,
  "gstin_masked" text NOT NULL,
  "gstin_hash" text NOT NULL,
  "state_code" text NOT NULL CHECK ("state_code" ~ '^[0-9]{2}$'),
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','VERIFIED','MANUAL_REVIEW','FAILED')),
  "legal_name" text,
  "trade_name" text,
  "outlet_address" text,
  "outlet_pincode" text,
  "provider_id" text,
  "provider_ref" text,
  "last_error_code" text,
  "consent_given_at" timestamp with time zone,
  "consent_version" text,
  "added_by" uuid,
  "verified_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "removed_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_gst_registrations_shop_idx" ON "shop_gst_registrations" ("shop_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_gst_registrations_shop_hash_uq" ON "shop_gst_registrations" ("shop_id", "gstin_hash") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_gst_registrations_shop_state_uq" ON "shop_gst_registrations" ("shop_id", "state_code") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_gst_registrations_hash_idx" ON "shop_gst_registrations" ("gstin_hash");
