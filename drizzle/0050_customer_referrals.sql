-- 0050 Customer referral rewards (F11): each customer's code and the referrals made
-- with it. New tables only. Rollback: scripts/rollback-0050.sql
CREATE TABLE "customer_referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_user_id" uuid NOT NULL,
	"referee_user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"rejection_reason" text,
	"qualifying_order_id" uuid,
	"referrer_reward_paise" bigint,
	"referee_reward_paise" bigint,
	"referee_phone_e164" text,
	"rewarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_referrals_not_self" CHECK ("customer_referrals"."referrer_user_id" <> "customer_referrals"."referee_user_id")
);
--> statement-breakpoint
ALTER TABLE "customer_referral_codes" ADD CONSTRAINT "customer_referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_referee_user_id_users_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_qualifying_order_id_orders_id_fk" FOREIGN KEY ("qualifying_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referral_codes_code_uq" ON "customer_referral_codes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_referee_uq" ON "customer_referrals" USING btree ("referee_user_id");--> statement-breakpoint
CREATE INDEX "customer_referrals_referrer_idx" ON "customer_referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_rewarded_phone_uq" ON "customer_referrals" USING btree ("referee_phone_e164") WHERE "customer_referrals"."status" = 'REWARDED' AND "customer_referrals"."referee_phone_e164" IS NOT NULL;