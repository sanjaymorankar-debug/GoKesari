CREATE TYPE "public"."financial_adjustment_status" AS ENUM('PENDING', 'SETTLED', 'RECORDED');--> statement-breakpoint
CREATE TYPE "public"."financial_adjustment_type" AS ENUM('REFUND_SHOP', 'REFUND_PLATFORM', 'SHOP_ADJUSTMENT', 'RIDER_ADJUSTMENT', 'DELIVERY_ADJUSTMENT', 'MARKETPLACE_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."commission_scope" AS ENUM('DEFAULT', 'SHOP_TYPE', 'SHOP');--> statement-breakpoint
CREATE TYPE "public"."financial_party" AS ENUM('SHOP', 'RIDER', 'PLATFORM');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('GOODS_SALE', 'COMMISSION', 'DELIVERY_FEE', 'PROMOTIONAL_DISCOUNT', 'RIDER_EARNING', 'REFUND', 'ADJUSTMENT', 'SHOP_SETTLEMENT', 'RIDER_PAYOUT', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('PENDING', 'ELIGIBLE', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_entity" AS ENUM('PAYMENT', 'ORDER', 'SHOP', 'RIDER', 'SETTLEMENT', 'PAYOUT');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('UNMATCHED', 'MATCHED', 'PARTIAL', 'EXCEPTION', 'RECONCILED');--> statement-breakpoint
CREATE TABLE "commission_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "commission_scope" NOT NULL,
	"shop_type" "shop_type",
	"shop_id" uuid,
	"rate_bp" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rates_range" CHECK ("commission_rates"."rate_bp" BETWEEN 0 AND 5000),
	CONSTRAINT "commission_rates_scope_target" CHECK (("commission_rates"."scope" = 'DEFAULT' AND "commission_rates"."shop_type" IS NULL AND "commission_rates"."shop_id" IS NULL)
          OR ("commission_rates"."scope" = 'SHOP_TYPE' AND "commission_rates"."shop_type" IS NOT NULL AND "commission_rates"."shop_id" IS NULL)
          OR ("commission_rates"."scope" = 'SHOP' AND "commission_rates"."shop_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "finance_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"entity_type" "financial_party" NOT NULL,
	"entity_id" uuid,
	"entry_type" "ledger_entry_type" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reference" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_ledger_amount_positive" CHECK ("finance_ledger_entries"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "financial_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "financial_adjustment_type" NOT NULL,
	"party" "financial_party" NOT NULL,
	"status" "financial_adjustment_status" DEFAULT 'PENDING' NOT NULL,
	"shop_id" uuid,
	"delivery_partner_id" uuid,
	"order_id" uuid,
	"wallet_transaction_id" uuid,
	"amount_paise" bigint NOT NULL,
	"customer_refund_paise" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"settlement_id" uuid,
	"payout_id" uuid,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_adjustments_party_target" CHECK (("financial_adjustments"."party" = 'SHOP' AND "financial_adjustments"."shop_id" IS NOT NULL)
          OR ("financial_adjustments"."party" = 'RIDER' AND "financial_adjustments"."delivery_partner_id" IS NOT NULL)
          OR "financial_adjustments"."party" = 'PLATFORM')
);
--> statement-breakpoint
CREATE TABLE "order_financials" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_transaction_id" uuid,
	"goods_paise" bigint NOT NULL,
	"discount_paise" bigint DEFAULT 0 NOT NULL,
	"delivery_fee_paise" bigint NOT NULL,
	"gmv_paise" bigint NOT NULL,
	"commission_rate_bp" integer NOT NULL,
	"commission_rate_id" uuid,
	"commission_paise" bigint NOT NULL,
	"shop_payable_paise" bigint NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" "reconciliation_entity" NOT NULL,
	"entity_id" text NOT NULL,
	"reference" text NOT NULL,
	"check_type" text NOT NULL,
	"expected_paise" bigint,
	"actual_paise" bigint,
	"status" "reconciliation_status" NOT NULL,
	"detail" text,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rider_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_partner_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"earnings_count" integer NOT NULL,
	"gross_paise" bigint NOT NULL,
	"adjustments_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"payment_reference" text,
	"failure_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shop_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"order_count" integer NOT NULL,
	"goods_paise" bigint NOT NULL,
	"commission_paise" bigint NOT NULL,
	"refunds_paise" bigint NOT NULL,
	"adjustments_paise" bigint NOT NULL,
	"net_payable_paise" bigint NOT NULL,
	"status" "payout_status" DEFAULT 'PENDING' NOT NULL,
	"payment_reference" text,
	"failure_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"processing_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_settlements_period" CHECK ("shop_settlements"."period_end" > "shop_settlements"."period_start")
);
--> statement-breakpoint
ALTER TABLE "delivery_partner_earnings" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_rates" ADD CONSTRAINT "commission_rates_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rates" ADD CONSTRAINT "commission_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_ledger_entries" ADD CONSTRAINT "finance_ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_ledger_entries" ADD CONSTRAINT "finance_ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_settlement_id_shop_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."shop_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_payout_id_rider_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."rider_payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_commission_rate_id_commission_rates_id_fk" FOREIGN KEY ("commission_rate_id") REFERENCES "public"."commission_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_financials" ADD CONSTRAINT "order_financials_settlement_id_shop_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."shop_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_payouts" ADD CONSTRAINT "rider_payouts_delivery_partner_id_delivery_partners_id_fk" FOREIGN KEY ("delivery_partner_id") REFERENCES "public"."delivery_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_payouts" ADD CONSTRAINT "rider_payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_payouts" ADD CONSTRAINT "rider_payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_payouts" ADD CONSTRAINT "rider_payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_settlements" ADD CONSTRAINT "shop_settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_rates_lookup_idx" ON "commission_rates" USING btree ("scope","shop_type","shop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_ledger_idempotency_unique" ON "finance_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "finance_ledger_order_idx" ON "finance_ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "finance_ledger_entity_idx" ON "finance_ledger_entries" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "finance_ledger_created_idx" ON "finance_ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_adjustments_idempotency_unique" ON "financial_adjustments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "financial_adjustments_shop_idx" ON "financial_adjustments" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "financial_adjustments_partner_idx" ON "financial_adjustments" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE INDEX "financial_adjustments_order_idx" ON "financial_adjustments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_financials_shop_idx" ON "order_financials" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "order_financials_settlement_idx" ON "order_financials" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "order_financials_delivered_idx" ON "order_financials" USING btree ("delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_entity_check_unique" ON "reconciliation_records" USING btree ("entity_type","entity_id","check_type");--> statement-breakpoint
CREATE INDEX "reconciliation_status_idx" ON "reconciliation_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rider_payouts_partner_idx" ON "rider_payouts" USING btree ("delivery_partner_id");--> statement-breakpoint
CREATE INDEX "rider_payouts_status_idx" ON "rider_payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shop_settlements_shop_idx" ON "shop_settlements" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_settlements_status_idx" ON "shop_settlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "delivery_partner_earnings_payout_idx" ON "delivery_partner_earnings" USING btree ("payout_id");