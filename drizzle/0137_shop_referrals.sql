-- split: seller
-- Owner brief, 2 Nov 2026 (docs/dealer-programme/TIERED_COMMISSION.md, Part B): shop-refers-shop,
-- the shop version of the customer referral reward (F11). Every approved shop gets its own code
-- ("SHOP" + 5 letters/digits) and link (/r/CODE). A registering shop enters one code — a dealer
-- code or a shop code, never both. The referred shop gets a fee discount or a welcome credit; the
-- referring shop gets promotional shop-wallet credit or a membership extension once the referred
-- shop is ACTIVATED and its first order DELIVERED (rule shopReferrals, off by default).
-- Promotional credit is tracked on the wallet (promo_balance_paise): spent on commission and
-- delivery charges only, never refunded to a bank. Safe to rerun. Rollback: scripts/rollback-0137.sql.
ALTER TABLE "shop_wallets" ADD COLUMN IF NOT EXISTS "promo_balance_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_wallets" DROP CONSTRAINT IF EXISTS "shop_wallets_promo";--> statement-breakpoint
ALTER TABLE "shop_wallets" ADD CONSTRAINT "shop_wallets_promo" CHECK ("promo_balance_paise" >= 0);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_referral_codes" (
	"shop_id" uuid PRIMARY KEY NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_referral_codes_format" CHECK ("code" ~ '^SHOP[A-HJ-NP-Z2-9]{5}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_referral_codes_code_unique" ON "shop_referral_codes" ("code");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
	"referred_shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE RESTRICT,
	"code" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"referred_mode" text NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"referred_reward_paise" integer DEFAULT 0 NOT NULL,
	"referrer_reward_kind" text,
	"referrer_reward_paise" integer DEFAULT 0 NOT NULL,
	"referrer_extension_months" integer DEFAULT 0 NOT NULL,
	"membership_before" timestamp with time zone,
	"membership_after" timestamp with time zone,
	"rejection_reason" text,
	"qualifying_order_id" uuid,
	"rewarded_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversal_reason" text,
	"referrer_recovered_paise" integer,
	"referred_recovered_paise" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_referrals_not_self" CHECK ("referrer_shop_id" <> "referred_shop_id"),
	CONSTRAINT "shop_referrals_status" CHECK ("status" in ('PENDING', 'REWARDED', 'REJECTED', 'REVERSED')),
	CONSTRAINT "shop_referrals_mode" CHECK ("referred_mode" in ('DISCOUNT', 'WALLET_CREDIT') AND ("referrer_reward_kind" IS NULL OR "referrer_reward_kind" in ('WALLET_CREDIT', 'MEMBERSHIP_EXTENSION'))),
	CONSTRAINT "shop_referrals_amounts" CHECK ("discount_paise" >= 0 AND "referred_reward_paise" >= 0 AND "referrer_reward_paise" >= 0 AND "referrer_extension_months" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_referrals_referred_unique" ON "shop_referrals" ("referred_shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_referrals_referrer_idx" ON "shop_referrals" ("referrer_shop_id", "status");
