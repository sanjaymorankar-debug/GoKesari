-- 0068 Shop self-registration with auto-approval (docs/three-modules-2026-10, Module 3).
--   registration_fee_tiers   Basic … Industry; amounts set by an admin; seeded INACTIVE.
--   distributor_types / distributors   commission default per type, override per distributor.
--   referral_codes +distributor_id +max_uses.
--   shop_registrations   one self-registration (PENDING_PAYMENT → APPROVED by the payment webhook).
--   registration_payments   gateway orders for the fee (separate from wallet payments).
--   referral_commissions   one per approved registration (recorded only).
--   outbound_test_messages   SMS/WhatsApp from the MOCK provider (test site only).
--   shops +onboarding_channel +shop_registration_id +registration_tier_id +auto_approved_at +profile_completed_at.
--   users +email_placeholder.   shop_payment_method +CASHFREE.
-- Additive. Rollback: scripts/rollback-0068.sql
ALTER TYPE "public"."shop_payment_method" ADD VALUE IF NOT EXISTS 'CASHFREE';--> statement-breakpoint
CREATE TABLE "distributor_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"commission_type" text NOT NULL,
	"commission_value" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distributor_types_commission" CHECK ("distributor_types"."commission_value" >= 0 AND ("distributor_types"."commission_type" <> 'PERCENT' OR "distributor_types"."commission_value" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "distributors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"distributor_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text,
	"email" text,
	"user_id" uuid,
	"district" text,
	"state" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"commission_type" text,
	"commission_value" integer,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distributors_commission_pair" CHECK (("distributors"."commission_type" IS NULL) = ("distributors"."commission_value" IS NULL)),
	CONSTRAINT "distributors_commission" CHECK ("distributors"."commission_value" IS NULL OR ("distributors"."commission_value" >= 0 AND ("distributors"."commission_type" <> 'PERCENT' OR "distributors"."commission_value" <= 10000)))
);
--> statement-breakpoint
CREATE TABLE "outbound_test_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"to_address" text NOT NULL,
	"body" text NOT NULL,
	"purpose" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_registration_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"referral_code_id" uuid NOT NULL,
	"distributor_id" uuid,
	"referrer_user_id" uuid,
	"base_paise" bigint NOT NULL,
	"commission_type" text NOT NULL,
	"commission_value" integer NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'ACCRUED' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_commissions_amount" CHECK ("referral_commissions"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "registration_fee_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_fee_tiers_amount" CHECK ("registration_fee_tiers"."amount_paise" >= 0 AND (NOT "registration_fee_tiers"."is_active" OR "registration_fee_tiers"."amount_paise" > 0))
);
--> statement-breakpoint
CREATE TABLE "registration_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_registration_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"gateway_order_id" text NOT NULL,
	"gateway_payment_id" text,
	"payment_session_id" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"failure_reason" text,
	"webhook_payload" jsonb,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"shop_name" text NOT NULL,
	"mobile_e164" text NOT NULL,
	"mobile_verified_at" timestamp with time zone NOT NULL,
	"referral_code_id" uuid NOT NULL,
	"distributor_id" uuid,
	"fee_tier_id" uuid NOT NULL,
	"fee_paise" bigint NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"owner_user_id" uuid,
	"shop_id" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_link_sent_at" timestamp with time zone,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_registrations_fee_positive" CHECK ("shop_registrations"."fee_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "referral_codes" ADD COLUMN "distributor_id" uuid;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "onboarding_channel" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "shop_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "registration_tier_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "auto_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "profile_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_placeholder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "distributor_types" ADD CONSTRAINT "distributor_types_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributors" ADD CONSTRAINT "distributors_distributor_type_id_distributor_types_id_fk" FOREIGN KEY ("distributor_type_id") REFERENCES "public"."distributor_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributors" ADD CONSTRAINT "distributors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distributors" ADD CONSTRAINT "distributors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_shop_registration_id_shop_registrations_id_fk" FOREIGN KEY ("shop_registration_id") REFERENCES "public"."shop_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_distributor_id_distributors_id_fk" FOREIGN KEY ("distributor_id") REFERENCES "public"."distributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_commissions" ADD CONSTRAINT "referral_commissions_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_fee_tiers" ADD CONSTRAINT "registration_fee_tiers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_payments" ADD CONSTRAINT "registration_payments_shop_registration_id_shop_registrations_id_fk" FOREIGN KEY ("shop_registration_id") REFERENCES "public"."shop_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_registrations" ADD CONSTRAINT "shop_registrations_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_registrations" ADD CONSTRAINT "shop_registrations_distributor_id_distributors_id_fk" FOREIGN KEY ("distributor_id") REFERENCES "public"."distributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_registrations" ADD CONSTRAINT "shop_registrations_fee_tier_id_registration_fee_tiers_id_fk" FOREIGN KEY ("fee_tier_id") REFERENCES "public"."registration_fee_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_registrations" ADD CONSTRAINT "shop_registrations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_registrations" ADD CONSTRAINT "shop_registrations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "distributor_types_code_unique" ON "distributor_types" USING btree ("code");--> statement-breakpoint
CREATE INDEX "distributors_type_idx" ON "distributors" USING btree ("distributor_type_id");--> statement-breakpoint
CREATE INDEX "outbound_test_messages_created_idx" ON "outbound_test_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbound_test_messages_to_idx" ON "outbound_test_messages" USING btree ("to_address","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_commissions_registration_unique" ON "referral_commissions" USING btree ("shop_registration_id");--> statement-breakpoint
CREATE INDEX "referral_commissions_distributor_idx" ON "referral_commissions" USING btree ("distributor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_fee_tiers_code_unique" ON "registration_fee_tiers" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_payments_order_unique" ON "registration_payments" USING btree ("gateway_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_payments_payment_unique" ON "registration_payments" USING btree ("gateway_payment_id");--> statement-breakpoint
CREATE INDEX "registration_payments_registration_idx" ON "registration_payments" USING btree ("shop_registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_registrations_token_unique" ON "shop_registrations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_registrations_shop_unique" ON "shop_registrations" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_registrations_code_status_idx" ON "shop_registrations" USING btree ("referral_code_id","status");--> statement-breakpoint
CREATE INDEX "shop_registrations_mobile_idx" ON "shop_registrations" USING btree ("mobile_e164","created_at");--> statement-breakpoint
CREATE INDEX "shop_registrations_status_idx" ON "shop_registrations" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_distributor_id_distributors_id_fk" FOREIGN KEY ("distributor_id") REFERENCES "public"."distributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_shop_registration_id_shop_registrations_id_fk" FOREIGN KEY ("shop_registration_id") REFERENCES "public"."shop_registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_registration_tier_id_registration_fee_tiers_id_fk" FOREIGN KEY ("registration_tier_id") REFERENCES "public"."registration_fee_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_max_uses_positive" CHECK ("referral_codes"."max_uses" IS NULL OR "referral_codes"."max_uses" > 0);;--> statement-breakpoint
INSERT INTO "registration_fee_tiers" ("code", "label", "description", "sort_order") VALUES
  ('BASIC', 'Basic', 'Set the amount and switch it on in Admin → Self-registration.', 1),
  ('SILVER', 'Silver', NULL, 2),
  ('GOLD', 'Gold', NULL, 3),
  ('PLATINUM', 'Platinum', NULL, 4),
  ('INDUSTRY', 'Industry', NULL, 5)
ON CONFLICT ("code") DO NOTHING;
