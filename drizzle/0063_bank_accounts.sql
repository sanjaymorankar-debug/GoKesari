-- 0063 Bank accounts and ₹1 verification (docs/four-features-2026-10, feature 3):
-- a customer's refund account / a shop's payout account (account number and UPI
-- ID encrypted by the app) and each ₹1 verification payment with its refund.
-- Additive only (two new tables). Rollback: scripts/rollback-0063.sql.
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"shop_id" uuid,
	"holder_type" text NOT NULL,
	"method" text NOT NULL,
	"account_holder_name" text NOT NULL,
	"account_number_encrypted" text,
	"account_number_last4" text,
	"ifsc" text,
	"upi_id_encrypted" text,
	"upi_id_masked" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"matched_account_holder_name" text,
	"name_match_score" integer,
	"match_method" text,
	"verified_at" timestamp with time zone,
	"verification_payment_method" text,
	"gateway_reference" text,
	"failure_reason" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_details" CHECK (("bank_accounts"."method" = 'BANK_ACCOUNT' AND "bank_accounts"."account_number_encrypted" IS NOT NULL AND "bank_accounts"."ifsc" IS NOT NULL) OR ("bank_accounts"."method" = 'UPI' AND "bank_accounts"."upi_id_encrypted" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "bank_verification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"gateway_order_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"payment_method" text,
	"gateway_payment_id" text,
	"payer_details" jsonb,
	"failure_reason" text,
	"refund_status" text DEFAULT 'NOT_REQUIRED' NOT NULL,
	"refund_reference" text,
	"refunded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_verification_attempts_amount" CHECK ("bank_verification_attempts"."amount_paise" > 0 AND "bank_verification_attempts"."amount_paise" <= 1000)
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_verification_attempts" ADD CONSTRAINT "bank_verification_attempts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_verification_attempts" ADD CONSTRAINT "bank_verification_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_customer_current_uq" ON "bank_accounts" USING btree ("user_id") WHERE "bank_accounts"."shop_id" IS NULL AND "bank_accounts"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_shop_current_uq" ON "bank_accounts" USING btree ("shop_id") WHERE "bank_accounts"."shop_id" IS NOT NULL AND "bank_accounts"."is_current";--> statement-breakpoint
CREATE INDEX "bank_accounts_status_idx" ON "bank_accounts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_verification_attempts_order_uq" ON "bank_verification_attempts" USING btree ("gateway_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_verification_attempts_payment_uq" ON "bank_verification_attempts" USING btree ("gateway_payment_id");--> statement-breakpoint
CREATE INDEX "bank_verification_attempts_account_idx" ON "bank_verification_attempts" USING btree ("bank_account_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_verification_attempts_user_idx" ON "bank_verification_attempts" USING btree ("user_id","created_at");