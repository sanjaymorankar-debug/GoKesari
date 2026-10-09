-- 0066 Refunds to a customer's bank (docs/four-features-2026-10, decided by the
-- owner on 9 Oct 2026): a customer can have a refund sent to their verified
-- bank account instead of keeping it in the wallet; finance sends it and
-- records the bank reference. Additive only (one new table).
-- Rollback: scripts/rollback-0066.sql.
CREATE TABLE "bank_refund_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refund_transaction_id" uuid NOT NULL,
	"order_id" uuid,
	"bank_account_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"account_label" text NOT NULL,
	"account_holder_name" text NOT NULL,
	"debit_transaction_id" uuid,
	"return_transaction_id" uuid,
	"payout_reference" text,
	"failure_reason" text,
	"processing_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_refund_requests_amount" CHECK ("bank_refund_requests"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_refund_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("refund_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_debit_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("debit_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_return_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("return_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_refund_requests" ADD CONSTRAINT "bank_refund_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_refund_requests_refund_uq" ON "bank_refund_requests" USING btree ("refund_transaction_id");--> statement-breakpoint
CREATE INDEX "bank_refund_requests_user_idx" ON "bank_refund_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "bank_refund_requests_status_idx" ON "bank_refund_requests" USING btree ("status","created_at");