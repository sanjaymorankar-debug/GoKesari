-- 0059 Shop prepaid wallet + hashed delivery codes (docs/shop-wallet-delivery-otp-2026-10).
--   shop_wallets / shop_wallet_transactions   one prepaid wallet per shop and its
--       immutable ledger. The balance moves ONLY by inserting a ledger row: a
--       trigger checks the row against the locked wallet and applies it, any
--       other UPDATE of balance_paise is refused, and ledger rows cannot be
--       updated or deleted. One COMMISSION and one DELIVERY_CHARGE per order.
--   payments.shop_id + purpose SHOP_WALLET_TOPUP   a shop wallet top-up through
--       the same Cashfree flow as a customer top-up.
--   order_financials.commission_collection / shop_delivery_charge_paise   whether
--       the commission was withheld at settlement (as before) or debited from
--       the shop wallet, and the delivery charge debited.
--   delivery_orders.delivery_otp_hash (+ sent_at, resends, used_at, locked_at,
--       ticket_id)   the customer's delivery code as a salted HMAC instead of
--       plain text, resend limits, single use, and the lockout support ticket.
-- Additive: nothing changes until rule shopWallet is switched on (off by
-- default), except that new delivery codes are stored hashed. Plain-text codes
-- of finished deliveries are cleared; a drop under way keeps its code until it
-- is used (the column is dropped in a later release).
-- Rollback: scripts/rollback-0059.sql
CREATE TYPE "public"."shop_wallet_entry_type" AS ENUM('TOP_UP', 'COMMISSION', 'DELIVERY_CHARGE', 'MANUAL_CREDIT', 'MANUAL_DEBIT');--> statement-breakpoint
CREATE TABLE "shop_wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "shop_wallet_transactions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" "shop_wallet_entry_type" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"balance_before_paise" bigint NOT NULL,
	"balance_after_paise" bigint NOT NULL,
	"order_id" uuid,
	"payment_id" uuid,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_wallet_txn_amount_positive" CHECK ("shop_wallet_transactions"."amount_paise" > 0),
	CONSTRAINT "shop_wallet_txn_arithmetic" CHECK ("shop_wallet_transactions"."balance_after_paise" = "shop_wallet_transactions"."balance_before_paise" + CASE WHEN "shop_wallet_transactions"."direction" = 'CREDIT' THEN "shop_wallet_transactions"."amount_paise" ELSE -"shop_wallet_transactions"."amount_paise" END),
	CONSTRAINT "shop_wallet_txn_direction_matches_type" CHECK (("shop_wallet_transactions"."type" IN ('TOP_UP', 'MANUAL_CREDIT')) = ("shop_wallet_transactions"."direction" = 'CREDIT')),
	CONSTRAINT "shop_wallet_txn_order_charge_has_order" CHECK ("shop_wallet_transactions"."type" NOT IN ('COMMISSION', 'DELIVERY_CHARGE') OR "shop_wallet_transactions"."order_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "shop_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"low_balance_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_hash" text;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_resends" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD COLUMN "delivery_otp_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "commission_collection" text DEFAULT 'SETTLEMENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_financials" ADD COLUMN "shop_delivery_charge_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_wallet_id_shop_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."shop_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_wallet_transactions" ADD CONSTRAINT "shop_wallet_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_wallets" ADD CONSTRAINT "shop_wallets_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_wallet_txn_idempotency_unique" ON "shop_wallet_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_wallet_txn_order_charge_unique" ON "shop_wallet_transactions" USING btree ("order_id","type") WHERE "shop_wallet_transactions"."order_id" IS NOT NULL AND "shop_wallet_transactions"."type" IN ('COMMISSION', 'DELIVERY_CHARGE');--> statement-breakpoint
CREATE INDEX "shop_wallet_txn_shop_idx" ON "shop_wallet_transactions" USING btree ("shop_id","seq");--> statement-breakpoint
CREATE INDEX "shop_wallet_txn_order_idx" ON "shop_wallet_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_wallets_shop_unique" ON "shop_wallets" USING btree ("shop_id");--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_delivery_otp_ticket_id_grievances_id_fk" FOREIGN KEY ("delivery_otp_ticket_id") REFERENCES "public"."grievances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_shop_idx" ON "payments" USING btree ("shop_id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shop_topup_has_shop" CHECK (("payments"."purpose" = 'SHOP_WALLET_TOPUP') = ("payments"."shop_id" IS NOT NULL));
--> statement-breakpoint
-- The ledger is the only way a shop wallet's balance moves. AFTER INSERT, so a
-- row skipped or refused (idempotency key, double charge) never touches the
-- balance; the wallet row is locked, the entry must start from the current
-- balance, and its balance_after becomes the new balance.
CREATE OR REPLACE FUNCTION shop_wallet_txn_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w shop_wallets%ROWTYPE;
BEGIN
  SELECT * INTO w FROM shop_wallets WHERE id = NEW.wallet_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shop wallet % does not exist', NEW.wallet_id;
  END IF;
  IF w.shop_id <> NEW.shop_id THEN
    RAISE EXCEPTION 'shop wallet % does not belong to shop %', NEW.wallet_id, NEW.shop_id;
  END IF;
  IF NEW.balance_before_paise <> w.balance_paise THEN
    RAISE EXCEPTION 'shop wallet ledger out of step: balance is %, entry starts from %', w.balance_paise, NEW.balance_before_paise;
  END IF;
  UPDATE shop_wallets SET balance_paise = NEW.balance_after_paise, updated_at = now() WHERE id = NEW.wallet_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_wallet_txn_apply AFTER INSERT ON shop_wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION shop_wallet_txn_apply();--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_wallet_txn_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shop_wallet_transactions rows are immutable; write a correcting entry instead';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_wallet_txn_immutable BEFORE UPDATE OR DELETE ON shop_wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION shop_wallet_txn_immutable();--> statement-breakpoint
-- A wallet starts at zero, never changes shop, and its balance changes only
-- from inside shop_wallet_txn_apply (trigger depth 2). A direct UPDATE of
-- balance_paise — from the app or from a SQL console — is refused.
CREATE OR REPLACE FUNCTION shop_wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_paise <> 0 THEN
      RAISE EXCEPTION 'a shop wallet starts at zero; credit it with a shop_wallet_transactions row';
    END IF;
  ELSE
    IF NEW.shop_id <> OLD.shop_id THEN
      RAISE EXCEPTION 'a shop wallet cannot move to another shop';
    END IF;
    IF NEW.balance_paise IS DISTINCT FROM OLD.balance_paise AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'shop_wallets.balance_paise changes only through shop_wallet_transactions';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_wallets_guard BEFORE INSERT OR UPDATE ON shop_wallets
  FOR EACH ROW EXECUTE FUNCTION shop_wallets_guard();--> statement-breakpoint
-- Plain-text codes of deliveries that are over are no longer needed.
UPDATE delivery_orders SET delivery_otp = NULL WHERE delivery_otp IS NOT NULL AND status <> 'PICKED_UP';
