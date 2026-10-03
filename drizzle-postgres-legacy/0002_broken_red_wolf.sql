CREATE TYPE "public"."excel_row_status" AS ENUM('VALID', 'NO_CHANGE', 'INVALID_PRICE', 'DUPLICATE', 'NOT_FOUND', 'MISSING_FIELD');--> statement-breakpoint
CREATE TYPE "public"."excel_upload_status" AS ENUM('VALIDATED', 'APPLIED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."excel_upload_type" AS ENUM('GOODS', 'PRICES');--> statement-breakpoint
CREATE TYPE "public"."fee_payment_status" AS ENUM('PENDING', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."price_request_source" AS ENUM('SHOP_OWNER', 'OPERATOR', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."price_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('ACTIVE', 'INACTIVE', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."shop_payment_method" AS ENUM('CASH', 'UPI', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'RAZORPAY', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."shop_payment_type" AS ENUM('REGISTRATION_FEE', 'RENEWAL', 'ADJUSTMENT', 'REFUND', 'REVERSAL');--> statement-breakpoint
CREATE TABLE "excel_upload_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data" jsonb,
	"product_code" text,
	"product_name" text,
	"unit" text,
	"parsed_price_paise" bigint,
	"previous_price_paise" bigint,
	"matched_shop_product_id" uuid,
	"status" "excel_row_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "excel_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"upload_type" "excel_upload_type" DEFAULT 'PRICES' NOT NULL,
	"status" "excel_upload_status" DEFAULT 'VALIDATED' NOT NULL,
	"file_name" text NOT NULL,
	"file_size_bytes" integer DEFAULT 0 NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"invalid_rows" integer DEFAULT 0 NOT NULL,
	"unchanged_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"not_found_rows" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"error_message" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_update_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"source" "price_request_source" NOT NULL,
	"submitted_by" uuid NOT NULL,
	"excel_upload_id" uuid,
	"status" "price_request_status" DEFAULT 'PENDING' NOT NULL,
	"note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_update_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"shop_product_id" uuid NOT NULL,
	"price_type" text NOT NULL,
	"previous_price_paise" bigint,
	"proposed_price_paise" bigint NOT NULL,
	"status" "price_request_status" DEFAULT 'PENDING' NOT NULL,
	"source" "price_request_source" NOT NULL,
	"submitted_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_update_requests_price_non_negative" CHECK ("price_update_requests"."proposed_price_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text,
	"referrer_name" text,
	"referrer_user_id" uuid,
	"status" "referral_status" DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" date,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_code_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"registration_fee_paise" bigint,
	"redeemed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_fee_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_fee_id" uuid NOT NULL,
	"previous_amount_paise" bigint,
	"new_amount_paise" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"changed_by" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registration_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_fees_amount_non_negative" CHECK ("registration_fees"."amount_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shop_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"shop_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"payment_type" "shop_payment_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"method" "shop_payment_method" DEFAULT 'CASH' NOT NULL,
	"transaction_id" text,
	"fee_snapshot_paise" bigint,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"receipt_url" text,
	"reversal_of_id" uuid,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_payments_amount_non_zero" CHECK ("shop_payments"."amount_paise" <> 0)
);
--> statement-breakpoint
-- products.code is NOT NULL in the schema, but the table already holds rows, so
-- it is added nullable, backfilled, and only then constrained. A sequence
-- allocates the SKU: callers never supply one, and concurrent inserts cannot
-- collide on the unique index.
CREATE SEQUENCE IF NOT EXISTS "product_code_seq" AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "code" text;--> statement-breakpoint
UPDATE "products"
SET "code" = 'P' || LPAD(nextval('product_code_seq')::text, 5, '0')
WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "code" SET DEFAULT ('P' || lpad(nextval('product_code_seq')::text, 5, '0'));--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "registration_date" date;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "registration_fee_paise" bigint;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "registration_fee_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "referral_code_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "fee_payment_status" "fee_payment_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "amount_paid_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "excel_upload_items" ADD CONSTRAINT "excel_upload_items_upload_id_excel_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."excel_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excel_upload_items" ADD CONSTRAINT "excel_upload_items_matched_shop_product_id_shop_products_id_fk" FOREIGN KEY ("matched_shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excel_uploads" ADD CONSTRAINT "excel_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "excel_uploads" ADD CONSTRAINT "excel_uploads_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_batches" ADD CONSTRAINT "price_update_batches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_batches" ADD CONSTRAINT "price_update_batches_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_batches" ADD CONSTRAINT "price_update_batches_excel_upload_id_excel_uploads_id_fk" FOREIGN KEY ("excel_upload_id") REFERENCES "public"."excel_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_batches" ADD CONSTRAINT "price_update_batches_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_requests" ADD CONSTRAINT "price_update_requests_batch_id_price_update_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."price_update_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_requests" ADD CONSTRAINT "price_update_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_requests" ADD CONSTRAINT "price_update_requests_shop_product_id_shop_products_id_fk" FOREIGN KEY ("shop_product_id") REFERENCES "public"."shop_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_requests" ADD CONSTRAINT "price_update_requests_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_requests" ADD CONSTRAINT "price_update_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_redemptions" ADD CONSTRAINT "referral_redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_fee_history" ADD CONSTRAINT "registration_fee_history_registration_fee_id_registration_fees_id_fk" FOREIGN KEY ("registration_fee_id") REFERENCES "public"."registration_fees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_fee_history" ADD CONSTRAINT "registration_fee_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_fees" ADD CONSTRAINT "registration_fees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_payments" ADD CONSTRAINT "shop_payments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_payments" ADD CONSTRAINT "shop_payments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_payments" ADD CONSTRAINT "shop_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "excel_upload_items_row_unique" ON "excel_upload_items" USING btree ("upload_id","row_number");--> statement-breakpoint
CREATE INDEX "excel_upload_items_upload_idx" ON "excel_upload_items" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "excel_uploads_shop_idx" ON "excel_uploads" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "excel_uploads_uploader_idx" ON "excel_uploads" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "excel_uploads_created_idx" ON "excel_uploads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "price_update_batches_shop_idx" ON "price_update_batches" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "price_update_batches_status_idx" ON "price_update_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "price_update_requests_batch_idx" ON "price_update_requests" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "price_update_requests_shop_idx" ON "price_update_requests" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "price_update_requests_status_idx" ON "price_update_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "price_update_requests_sp_idx" ON "price_update_requests" USING btree ("shop_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_unique" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referral_codes_status_idx" ON "referral_codes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_redemptions_shop_unique" ON "referral_redemptions" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "referral_redemptions_code_idx" ON "referral_redemptions" USING btree ("referral_code_id");--> statement-breakpoint
CREATE INDEX "registration_fee_history_created_idx" ON "registration_fee_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "registration_fees_effective_idx" ON "registration_fees" USING btree ("effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_payments_reference_unique" ON "shop_payments" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "shop_payments_shop_idx" ON "shop_payments" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shop_payments_owner_idx" ON "shop_payments" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "shop_payments_paid_idx" ON "shop_payments" USING btree ("paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_code_unique" ON "products" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "shops_registration_number_unique" ON "shops" USING btree ("registration_number");--> statement-breakpoint
CREATE INDEX "shops_fee_status_idx" ON "shops" USING btree ("fee_payment_status");--> statement-breakpoint
CREATE INDEX "shops_referral_idx" ON "shops" USING btree ("referral_code_id");--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_registration_amounts_non_negative" CHECK (("shops"."registration_fee_paise" IS NULL OR "shops"."registration_fee_paise" >= 0)
          AND "shops"."amount_paid_paise" >= 0);--> statement-breakpoint
-- shops.registration_fee_id / referral_code_id are declared as plain uuid in
-- schema.ts because registration_fees and referral_codes are defined *after*
-- shops in that file — a drizzle .references() there would be a forward
-- reference at module-init time. The referential integrity is real, so the
-- constraints are added here instead. RESTRICT: a fee row or referral code that
-- a shop points at must not be deletable out from under it.
ALTER TABLE "shops" ADD CONSTRAINT "shops_registration_fee_id_fk" FOREIGN KEY ("registration_fee_id") REFERENCES "public"."registration_fees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_referral_code_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_payments" ADD CONSTRAINT "shop_payments_reversal_of_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."shop_payments"("id") ON DELETE restrict ON UPDATE no action;