-- 0073 Bank account check with Cashfree Verification Suite (docs/four-features-2026-10,
-- the owner's decision O-7): one row per check of a bank account with the bank.
-- Additive only (one new table). Rollback: scripts/rollback-0073.sql.
CREATE TABLE "bank_account_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text DEFAULT 'CASHFREE_BAV' NOT NULL,
	"result" text NOT NULL,
	"status_code" text,
	"reference_id" text,
	"name_at_bank" text,
	"bank_name" text,
	"branch" text,
	"city" text,
	"name_match_score" integer,
	"name_match_result" text,
	"verified" boolean DEFAULT false NOT NULL,
	"http_status" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_account_checks" ADD CONSTRAINT "bank_account_checks_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account_checks" ADD CONSTRAINT "bank_account_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_account_checks_account_idx" ON "bank_account_checks" USING btree ("bank_account_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_account_checks_user_idx" ON "bank_account_checks" USING btree ("user_id","created_at");