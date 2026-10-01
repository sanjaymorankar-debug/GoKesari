CREATE TABLE "rider_earning_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"days_of_week" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_fee_paise" bigint,
	"per_km_fee_paise" bigint,
	"min_earning_paise" bigint,
	"order_fee_paise" bigint DEFAULT 0 NOT NULL,
	"order_percent_bp" integer DEFAULT 0 NOT NULL,
	"peak_bonus_paise" bigint DEFAULT 0 NOT NULL,
	"is_peak" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_slots_percent_range" CHECK ("rider_earning_slots"."order_percent_bp" BETWEEN 0 AND 10000),
	CONSTRAINT "rider_slots_amounts_non_negative" CHECK ("rider_earning_slots"."order_fee_paise" >= 0 AND "rider_earning_slots"."peak_bonus_paise" >= 0
          AND ("rider_earning_slots"."base_fee_paise" IS NULL OR "rider_earning_slots"."base_fee_paise" >= 0)
          AND ("rider_earning_slots"."per_km_fee_paise" IS NULL OR "rider_earning_slots"."per_km_fee_paise" >= 0)
          AND ("rider_earning_slots"."min_earning_paise" IS NULL OR "rider_earning_slots"."min_earning_paise" >= 0))
);
--> statement-breakpoint
CREATE TABLE "rider_earnings_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"earning_id" uuid NOT NULL,
	"delivery_order_id" uuid,
	"component" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rider_incentive_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"earning_id" uuid,
	"period_key" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rider_incentive_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"threshold_value" integer DEFAULT 0 NOT NULL,
	"reward_paise" bigint NOT NULL,
	"period" text DEFAULT 'DAY' NOT NULL,
	"start_time" text,
	"end_time" text,
	"days_of_week" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_incentive_reward_positive" CHECK ("rider_incentive_rules"."reward_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "order_component_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "slot_incentive_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "min_top_up_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "order_incentive_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "other_incentive_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "deductions_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "slot_id" uuid;--> statement-breakpoint
ALTER TABLE "rider_earning_slots" ADD CONSTRAINT "rider_earning_slots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_earnings_ledger" ADD CONSTRAINT "rider_earnings_ledger_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_earnings_ledger" ADD CONSTRAINT "rider_earnings_ledger_earning_id_delivery_partner_earnings_id_fk" FOREIGN KEY ("earning_id") REFERENCES "public"."delivery_partner_earnings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_earnings_ledger" ADD CONSTRAINT "rider_earnings_ledger_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_incentive_awards" ADD CONSTRAINT "rider_incentive_awards_rule_id_rider_incentive_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rider_incentive_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_incentive_awards" ADD CONSTRAINT "rider_incentive_awards_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_incentive_awards" ADD CONSTRAINT "rider_incentive_awards_earning_id_delivery_partner_earnings_id_fk" FOREIGN KEY ("earning_id") REFERENCES "public"."delivery_partner_earnings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_incentive_rules" ADD CONSTRAINT "rider_incentive_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rider_earnings_ledger_earning_idx" ON "rider_earnings_ledger" USING btree ("earning_id");--> statement-breakpoint
CREATE INDEX "rider_earnings_ledger_partner_idx" ON "rider_earnings_ledger" USING btree ("delivery_partner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rider_incentive_awards_unique" ON "rider_incentive_awards" USING btree ("rule_id","delivery_partner_id","period_key");