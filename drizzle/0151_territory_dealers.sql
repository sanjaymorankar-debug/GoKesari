-- Territory dealers (owner, 20-Nov-2026; docs/dealer-programme/TERRITORY_DEALER.md). New tables only, plus
-- three widened checks: the ledger may carry TERRITORY entries (no shop, like BONUS) and payment intents the
-- TERRITORY_FEE purpose. Nothing changes until an admin switches rule territoryDealer on and gives a TIERED
-- dealer a territory. Rollback: scripts/rollback-0151.sql
CREATE TABLE IF NOT EXISTS "dealer_exclusive_territories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"name" text NOT NULL,
	"status" text DEFAULT 'AWAITING_FEE' NOT NULL,
	"fee_paise" integer NOT NULL,
	"paid_until" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"rating" numeric(3, 1) DEFAULT 5 NOT NULL,
	"share_bp" integer DEFAULT 2000 NOT NULL,
	"rated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_exclusive_territories_status" CHECK ("status" IN ('AWAITING_FEE', 'ACTIVE', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "dealer_exclusive_territories_fee" CHECK ("fee_paise" > 0),
	CONSTRAINT "dealer_exclusive_territories_share" CHECK ("share_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_exclusive_territories_dealer_idx" ON "dealer_exclusive_territories" ("dealer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_territory_pincodes" (
	"territory_id" uuid NOT NULL REFERENCES "dealer_exclusive_territories"("id") ON DELETE restrict,
	"pincode" text NOT NULL,
	"held_from" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "dealer_territory_pincodes_pk" PRIMARY KEY ("territory_id", "pincode", "held_from"),
	CONSTRAINT "dealer_territory_pincodes_pincode" CHECK ("pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
-- The exclusivity: a pincode is held by one territory at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_territory_pincodes_held_unique" ON "dealer_territory_pincodes" ("pincode") WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_territory_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"territory_id" uuid NOT NULL REFERENCES "dealer_exclusive_territories"("id") ON DELETE restrict,
	"amount_paise" integer NOT NULL,
	"status" text DEFAULT 'AWAITING_PAYMENT' NOT NULL,
	"method" text,
	"payment_intent_id" uuid,
	"reference" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_territory_fees_status" CHECK ("status" IN ('AWAITING_PAYMENT', 'PAID', 'CANCELLED')),
	CONSTRAINT "dealer_territory_fees_method" CHECK ("method" IS NULL OR "method" IN ('ONLINE', 'OFFLINE')),
	CONSTRAINT "dealer_territory_fees_amount" CHECK ("amount_paise" > 0),
	CONSTRAINT "dealer_territory_fees_period" CHECK ("status" <> 'PAID' OR ("period_start" IS NOT NULL AND "period_end" > "period_start"))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_territory_fees_territory_idx" ON "dealer_territory_fees" ("territory_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_territory_fees_open_unique" ON "dealer_territory_fees" ("territory_id") WHERE "status" = 'AWAITING_PAYMENT';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_territory_ratings" (
	"territory_id" uuid NOT NULL REFERENCES "dealer_exclusive_territories"("id") ON DELETE restrict,
	"day" date NOT NULL,
	"onboarding_rating" numeric(3, 1) NOT NULL,
	"shops_total" integer NOT NULL,
	"shops_live" integer NOT NULL,
	"onboarding_points" numeric(3, 1) NOT NULL,
	"product_points" numeric(3, 1) NOT NULL,
	"rating" numeric(3, 1) NOT NULL,
	"share_bp" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealer_territory_ratings_pk" PRIMARY KEY ("territory_id", "day")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dealer_territory_order_shares" (
	"order_id" uuid PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE restrict,
	"territory_id" uuid NOT NULL REFERENCES "dealer_exclusive_territories"("id") ON DELETE restrict,
	"dealer_id" uuid NOT NULL REFERENCES "dealers"("id") ON DELETE restrict,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE restrict,
	"month" text NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"commission_paise" bigint NOT NULL,
	"refunded_commission_paise" bigint DEFAULT 0 NOT NULL,
	"share_bp" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"ledger_entry_id" uuid REFERENCES "dealer_commission_ledger"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_territory_order_shares_territory_idx" ON "dealer_territory_order_shares" ("territory_id", "month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dealer_territory_order_shares_dealer_idx" ON "dealer_territory_order_shares" ("dealer_id", "month");
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_entry_type";
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_entry_type" CHECK ("entry_type" in ('BASE', 'DIRECT_1', 'DIRECT_2', 'OVERRIDE_LEAD', 'OVERRIDE_MAIN', 'RENEWAL', 'DEVELOPMENT', 'BONUS', 'TERRITORY'));
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" DROP CONSTRAINT IF EXISTS "dealer_commission_ledger_shop";
--> statement-breakpoint
ALTER TABLE "dealer_commission_ledger" ADD CONSTRAINT "dealer_commission_ledger_shop" CHECK ("shop_id" IS NOT NULL OR "entry_type" IN ('BONUS', 'TERRITORY'));
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_purpose_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("purpose" IN ('ORDER', 'ORDER_GROUP', 'SHOP_REGISTRATION_FEE', 'SUPPORT_SERVICE', 'TERRITORY_FEE'));
