-- Subscription plans (docs/subscription-plans-2026-11): any shop offers one of its products on repeat —
-- a tiffin kitchen's lunch, a dairy's milk, a paper agent's newspaper — with a kind, a slot, serving
-- days, allowed schedules, an optional subscriber price, fixed terms and lead days.
-- Additive only: a new table and one nullable column; existing subscriptions are untouched.
-- subscriptions.plan_id has no foreign key (seller and customer tables are linked in the service).
-- Rollback: scripts/rollback-0182.sql
CREATE TABLE IF NOT EXISTS "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE cascade,
	"shop_product_id" uuid NOT NULL REFERENCES "shop_products"("id") ON DELETE restrict,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'OTHER' NOT NULL,
	"slot" text DEFAULT 'ANYTIME' NOT NULL,
	"slot_window" text,
	"service_days" jsonb DEFAULT '[1,2,3,4,5,6,7]'::jsonb NOT NULL,
	"allowed_frequencies" jsonb DEFAULT '["DAILY","WEEKLY"]'::jsonb NOT NULL,
	"price_paise" bigint,
	"term_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_days" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subscription_plans_kind" CHECK ("kind" IN ('MEAL', 'NEWSPAPER', 'MILK_DAIRY', 'BAKERY', 'FLOWERS_PUJA', 'WATER', 'FRUITS_VEG', 'OTHER')),
	CONSTRAINT "subscription_plans_slot" CHECK ("slot" IN ('EARLY_MORNING', 'BREAKFAST', 'MORNING', 'LUNCH', 'SNACKS', 'EVENING', 'DINNER', 'ANYTIME')),
	CONSTRAINT "subscription_plans_price_positive" CHECK ("price_paise" IS NULL OR "price_paise" > 0),
	CONSTRAINT "subscription_plans_lead_days" CHECK ("lead_days" BETWEEN 0 AND 30)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_shop_idx" ON "subscription_plans" ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_kind_idx" ON "subscription_plans" ("kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_plans_shop_name_live_unique" ON "subscription_plans" ("shop_id", lower("name")) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "plan_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_plan_idx" ON "subscriptions" ("plan_id");
