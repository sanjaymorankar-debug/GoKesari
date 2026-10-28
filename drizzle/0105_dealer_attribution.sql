-- split: seller
-- Dealer programme step 3 (docs/dealer-programme, GKS-SH-002/003, GKS-RA-001): which dealer
-- brought a shop, documented leads with an attribution window, dealer-assisted registrations
-- (the owner confirms with a one-time code) and attribution disputes. ADDITIVE ONLY; idempotent.
-- Nothing here changes how a shop registers: rows are written after a registration, only while
-- the dealer programme is on for the shop's district.
CREATE TABLE IF NOT EXISTS "dealer_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"salesperson_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"shop_name" text NOT NULL,
	"owner_name" text,
	"phone_e164" text NOT NULL,
	"gstin" text,
	"pincode" text,
	"latitude" text,
	"longitude" text,
	"consent_at" timestamp with time zone NOT NULL,
	"consent_note" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_reason" text,
	"converted_shop_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_leads_status" CHECK ("status" in ('OPEN', 'CONVERTED', 'EXPIRED', 'CLOSED')),
	CONSTRAINT "dealer_leads_phone" CHECK ("phone_e164" ~ '^\+91[6-9][0-9]{9}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_leads_open_unique" ON "dealer_leads" ("dealer_id", "phone_e164") WHERE "status" = 'OPEN';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_leads_phone_idx" ON "dealer_leads" ("phone_e164", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_leads_dealer_idx" ON "dealer_leads" ("dealer_id", "status", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_attributions" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE RESTRICT,
	"salesperson_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"referral_code_id" uuid REFERENCES "referral_codes"("id") ON DELETE SET NULL,
	"lead_id" uuid REFERENCES "dealer_leads"("id") ON DELETE SET NULL,
	"source" text NOT NULL,
	"employee_text" text,
	"match_kind" text DEFAULT 'NONE' NOT NULL,
	"matched_shop_id" uuid,
	"match_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_attributions_source" CHECK ("source" in ('CODE_AT_REGISTRATION', 'DEALER_ASSISTED', 'LEAD', 'ADMIN')),
	CONSTRAINT "shop_attributions_match" CHECK ("match_kind" in ('NONE', 'DUPLICATE', 'BRANCH')),
	CONSTRAINT "shop_attributions_status" CHECK ("status" in ('ACTIVE', 'REVERSED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_attributions_dealer_idx" ON "shop_attributions" ("dealer_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_attributions_salesperson_idx" ON "shop_attributions" ("salesperson_id") WHERE "salesperson_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_assisted_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"salesperson_id" uuid REFERENCES "dealer_salespeople"("id") ON DELETE SET NULL,
	"owner_name" text NOT NULL,
	"owner_mobile_e164" text NOT NULL,
	"owner_email" text NOT NULL,
	"owner_user_id" uuid,
	"otp_channel" text NOT NULL,
	"status" text DEFAULT 'OTP_SENT' NOT NULL,
	"verified_at" timestamp with time zone,
	"consent_expires_at" timestamp with time zone,
	"shop_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_assisted_sessions_channel" CHECK ("otp_channel" in ('SMS', 'EMAIL')),
	CONSTRAINT "dealer_assisted_sessions_status" CHECK ("status" in ('OTP_SENT', 'OWNER_VERIFIED', 'SHOP_SUBMITTED', 'CANCELLED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_assisted_sessions_dealer_idx" ON "dealer_assisted_sessions" ("dealer_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_attribution_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE CASCADE,
	"shop_id" uuid REFERENCES "shops"("id") ON DELETE SET NULL,
	"lead_id" uuid REFERENCES "dealer_leads"("id") ON DELETE SET NULL,
	"claimed_phone_e164" text NOT NULL,
	"note" text NOT NULL,
	"ticket_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_attribution_disputes_status" CHECK ("status" in ('OPEN', 'UPHELD', 'REJECTED'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_attribution_disputes_status_idx" ON "dealer_attribution_disputes" ("status", "created_at");
