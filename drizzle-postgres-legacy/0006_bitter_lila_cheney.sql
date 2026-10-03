CREATE TYPE "public"."voucher_apply_mode" AS ENUM('CODE', 'AUTO_APPLY');--> statement-breakpoint
CREATE TYPE "public"."voucher_redemption_status" AS ENUM('PENDING', 'APPLIED', 'REVERSED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."voucher_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'BUDGET_EXHAUSTED');--> statement-breakpoint
CREATE TYPE "public"."voucher_upload_row_status" AS ENUM('VALID', 'DUPLICATE_IN_FILE', 'DUPLICATE_EXISTING', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."voucher_upload_status" AS ENUM('VALIDATED', 'APPLIED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "voucher_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"payment_id" uuid,
	"topup_amount_paise" bigint NOT NULL,
	"bonus_percent" bigint NOT NULL,
	"bonus_amount_paise" bigint NOT NULL,
	"status" "voucher_redemption_status" DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_redemptions_amounts_non_negative" CHECK ("voucher_redemptions"."topup_amount_paise" >= 0 AND "voucher_redemptions"."bonus_amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "voucher_upload_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data" jsonb,
	"voucher_name" text,
	"voucher_code" text,
	"status" "voucher_upload_row_status" NOT NULL,
	"error_message" text,
	"created_voucher_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voucher_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"file_name" text NOT NULL,
	"status" "voucher_upload_status" DEFAULT 'VALIDATED' NOT NULL,
	"total_records" integer DEFAULT 0 NOT NULL,
	"successful_records" integer DEFAULT 0 NOT NULL,
	"failed_records" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"terms_and_conditions" text,
	"apply_mode" "voucher_apply_mode" DEFAULT 'CODE' NOT NULL,
	"bonus_percent" bigint NOT NULL,
	"minimum_topup_paise" bigint DEFAULT 0 NOT NULL,
	"maximum_bonus_paise" bigint,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"usage_limit" integer,
	"per_customer_limit" integer DEFAULT 1 NOT NULL,
	"total_budget_paise" bigint,
	"budget_used_paise" bigint DEFAULT 0 NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"status" "voucher_status" DEFAULT 'DRAFT' NOT NULL,
	"applicable_scope" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_bonus_percent_range" CHECK ("vouchers"."bonus_percent" > 0 AND "vouchers"."bonus_percent" <= 100),
	CONSTRAINT "vouchers_minimum_topup_non_negative" CHECK ("vouchers"."minimum_topup_paise" >= 0),
	CONSTRAINT "vouchers_maximum_bonus_non_negative" CHECK ("vouchers"."maximum_bonus_paise" IS NULL OR "vouchers"."maximum_bonus_paise" >= 0),
	CONSTRAINT "vouchers_dates_valid" CHECK ("vouchers"."end_date" >= "vouchers"."start_date"),
	CONSTRAINT "vouchers_usage_limit_positive" CHECK ("vouchers"."usage_limit" IS NULL OR "vouchers"."usage_limit" > 0),
	CONSTRAINT "vouchers_per_customer_limit_positive" CHECK ("vouchers"."per_customer_limit" > 0),
	CONSTRAINT "vouchers_budget_non_negative" CHECK (("vouchers"."total_budget_paise" IS NULL OR "vouchers"."total_budget_paise" >= 0) AND "vouchers"."budget_used_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "promotional_amount_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "voucher_redemption_id" uuid;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "promotional_balance_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_upload_items" ADD CONSTRAINT "voucher_upload_items_upload_id_voucher_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."voucher_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_upload_items" ADD CONSTRAINT "voucher_upload_items_created_voucher_id_vouchers_id_fk" FOREIGN KEY ("created_voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voucher_uploads" ADD CONSTRAINT "voucher_uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_redemptions_idempotency_unique" ON "voucher_redemptions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "voucher_redemptions_voucher_idx" ON "voucher_redemptions" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "voucher_redemptions_user_idx" ON "voucher_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_upload_items_row_unique" ON "voucher_upload_items" USING btree ("upload_id","row_number");--> statement-breakpoint
CREATE INDEX "voucher_upload_items_upload_idx" ON "voucher_upload_items" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "voucher_uploads_uploader_idx" ON "voucher_uploads" USING btree ("uploaded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_code_unique" ON "vouchers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "vouchers_status_idx" ON "vouchers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vouchers_dates_idx" ON "vouchers" USING btree ("start_date","end_date");--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_txn_promotional_within_amount" CHECK (("wallet_transactions"."amount_paise" >= 0 AND "wallet_transactions"."promotional_amount_paise" >= 0 AND "wallet_transactions"."promotional_amount_paise" <= "wallet_transactions"."amount_paise")
          OR ("wallet_transactions"."amount_paise" < 0 AND "wallet_transactions"."promotional_amount_paise" <= 0 AND "wallet_transactions"."promotional_amount_paise" >= "wallet_transactions"."amount_paise"));--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_promotional_balance_bounded" CHECK ("wallets"."promotional_balance_paise" >= 0 AND "wallets"."promotional_balance_paise" <= "wallets"."balance_paise");--> statement-breakpoint
-- wallet_transactions.voucher_redemption_id is declared as a plain uuid in
-- schema.ts because voucher_redemptions is defined later in that file; the FK
-- is added here now that the table exists (same pattern as the earlier
-- shops.registration_fee_id / referral_codes forward-reference fix).
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_voucher_redemption_id_fk" FOREIGN KEY ("voucher_redemption_id") REFERENCES "public"."voucher_redemptions"("id") ON DELETE set null ON UPDATE no action;