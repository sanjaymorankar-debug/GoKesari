-- 0052 SM-004: subscription states and per-delivery status.
--   * subscription_status gains DRAFT (saved, not started) and RENEWAL_PENDING
--     (term ending soon, or the wallet will not cover the next delivery);
--     subscriptions.renewal_reason / renewal_due_date say which and when.
--   * subscription lifecycle (F1) gains DRAFT and RENEWAL_PENDING with new
--     transition rules (still enforced and logged by the 0042 trigger).
--   * subscription_deliveries: one row per delivery date with its own status -
--     SCHEDULED / SKIPPED, then exactly the day's order status. Triggers keep
--     it in step: orders -> subscription_orders -> subscription_deliveries.
--     subscription_orders.status, which used to stay at its generation-time
--     value, now follows its order too.
-- New enum values are only ever compared as text here, so this migration is
-- safe in the same transaction as the ADD VALUE statements.
-- Existing generated deliveries are copied in with their order's status;
-- future SCHEDULED rows are written by the app's schedule sync (daily run).
-- Rollback: scripts/rollback-0052.sql
CREATE TYPE "public"."subscription_delivery_status" AS ENUM('SCHEDULED', 'SKIPPED', 'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'PAYMENT_FAILED', 'WALLET_INSUFFICIENT', 'REFUND_PENDING', 'REFUNDED', 'ACCEPTED', 'ASSIGNED', 'PICKED_UP', 'FAILED', 'RETURNED', 'DISPUTED');--> statement-breakpoint
ALTER TYPE "public"."subscription_lifecycle_status" ADD VALUE 'DRAFT' BEFORE 'ACTIVE';--> statement-breakpoint
ALTER TYPE "public"."subscription_lifecycle_status" ADD VALUE 'RENEWAL_PENDING' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'DRAFT';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'RENEWAL_PENDING';--> statement-breakpoint
CREATE TABLE "subscription_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"delivery_date" date NOT NULL,
	"status" "subscription_delivery_status" DEFAULT 'SCHEDULED' NOT NULL,
	"quantity_milli" integer,
	"reason" text,
	"subscription_order_id" uuid,
	"order_id" uuid,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "renewal_reason" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "renewal_due_date" date;--> statement-breakpoint
ALTER TABLE "subscription_deliveries" ADD CONSTRAINT "subscription_deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_deliveries" ADD CONSTRAINT "subscription_deliveries_subscription_order_id_subscription_orders_id_fk" FOREIGN KEY ("subscription_order_id") REFERENCES "public"."subscription_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_deliveries" ADD CONSTRAINT "subscription_deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_deliveries_sub_date_unique" ON "subscription_deliveries" USING btree ("subscription_id","delivery_date");--> statement-breakpoint
CREATE INDEX "subscription_deliveries_date_idx" ON "subscription_deliveries" USING btree ("delivery_date");--> statement-breakpoint
CREATE INDEX "subscription_deliveries_order_idx" ON "subscription_deliveries" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_renewal_reason_valid"
  CHECK ("renewal_reason" IS NULL OR "renewal_reason" IN ('TERM_END', 'PAYMENT_DUE'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle_subscription(p_status subscription_status, p_from date, p_until date)
RETURNS subscription_lifecycle_status LANGUAGE plpgsql STABLE AS $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  s text := p_status::text;
BEGIN
  IF s = 'DRAFT' THEN RETURN 'DRAFT'; END IF;
  IF s = 'CANCELLED' THEN RETURN 'CANCELLED'; END IF;
  IF s = 'COMPLETED' THEN RETURN 'EXPIRED'; END IF;
  IF s = 'PAUSED' THEN RETURN 'PAUSED'; END IF;
  IF p_from IS NOT NULL AND p_from <= today AND (p_until IS NULL OR p_until >= today) THEN RETURN 'PAUSED'; END IF;
  IF s = 'RENEWAL_PENDING' THEN RETURN 'RENEWAL_PENDING'; END IF;
  RETURN 'ACTIVE';
END;
$$;--> statement-breakpoint
DELETE FROM status_transition_rules WHERE entity_type = 'SUBSCRIPTION';--> statement-breakpoint
INSERT INTO "status_transition_rules" ("entity_type","from_status","to_status") VALUES
  ('SUBSCRIPTION','DRAFT','ACTIVE'),
  ('SUBSCRIPTION','DRAFT','PAUSED'),
  ('SUBSCRIPTION','DRAFT','RENEWAL_PENDING'),
  ('SUBSCRIPTION','DRAFT','CANCELLED'),
  ('SUBSCRIPTION','ACTIVE','PAUSED'),
  ('SUBSCRIPTION','ACTIVE','RENEWAL_PENDING'),
  ('SUBSCRIPTION','ACTIVE','CANCELLED'),
  ('SUBSCRIPTION','ACTIVE','EXPIRED'),
  ('SUBSCRIPTION','PAUSED','ACTIVE'),
  ('SUBSCRIPTION','PAUSED','RENEWAL_PENDING'),
  ('SUBSCRIPTION','PAUSED','CANCELLED'),
  ('SUBSCRIPTION','PAUSED','EXPIRED'),
  ('SUBSCRIPTION','RENEWAL_PENDING','ACTIVE'),
  ('SUBSCRIPTION','RENEWAL_PENDING','PAUSED'),
  ('SUBSCRIPTION','RENEWAL_PENDING','CANCELLED'),
  ('SUBSCRIPTION','RENEWAL_PENDING','EXPIRED')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Mirrors isAllowedDeliveryTransition (lib/subscription-deliveries.ts).
CREATE OR REPLACE FUNCTION subscription_delivery_transition_ok(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to
      OR p_from IN ('SCHEDULED', 'SKIPPED')
      OR p_to NOT IN ('SCHEDULED', 'SKIPPED')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION subscription_deliveries_status_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enforce boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT subscription_delivery_transition_ok(OLD.status::text, NEW.status::text) THEN
      SELECT COALESCE((value->>'enforceTransitions')::boolean, true) INTO enforce
        FROM platform_settings WHERE key = 'statusModels';
      IF COALESCE(enforce, true) THEN
        RAISE EXCEPTION 'Delivery status change % -> % is not allowed', OLD.status, NEW.status
          USING ERRCODE = 'check_violation', HINT = 'lifecycle_transition';
      END IF;
    END IF;
    NEW.status_changed_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- The day's order exists: the delivery follows it from now on.
CREATE OR REPLACE FUNCTION subscription_orders_delivery_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO subscription_deliveries
    (subscription_id, delivery_date, status, quantity_milli, subscription_order_id, order_id, reason)
  VALUES (NEW.subscription_id, NEW.delivery_date, NEW.status::text::subscription_delivery_status,
          NEW.quantity_milli, NEW.id, NEW.order_id, NULL)
  ON CONFLICT (subscription_id, delivery_date) DO UPDATE
    SET status = EXCLUDED.status,
        quantity_milli = EXCLUDED.quantity_milli,
        subscription_order_id = EXCLUDED.subscription_order_id,
        order_id = EXCLUDED.order_id,
        reason = NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION orders_subscription_status_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE subscription_orders SET status = NEW.status
   WHERE order_id = NEW.id AND status IS DISTINCT FROM NEW.status;
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- Existing rows: bring subscription_orders up to date with their orders, then
-- copy every generated delivery and every future customer skip.
UPDATE subscription_orders so SET status = o.status
  FROM orders o WHERE o.id = so.order_id AND so.status IS DISTINCT FROM o.status;--> statement-breakpoint
INSERT INTO subscription_deliveries (subscription_id, delivery_date, status, quantity_milli, subscription_order_id, order_id)
  SELECT subscription_id, delivery_date, status::text::subscription_delivery_status, quantity_milli, id, order_id
    FROM subscription_orders
ON CONFLICT (subscription_id, delivery_date) DO NOTHING;--> statement-breakpoint
INSERT INTO subscription_deliveries (subscription_id, delivery_date, status, reason)
  SELECT o.subscription_id, o.delivery_date, 'SKIPPED', 'SKIPPED_BY_CUSTOMER'
    FROM subscription_daily_overrides o
    JOIN subscriptions s ON s.id = o.subscription_id
   WHERE o.type = 'SKIP' AND o.delivery_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date
     AND s.status::text IN ('ACTIVE', 'PAYMENT_PENDING')
ON CONFLICT (subscription_id, delivery_date) DO NOTHING;--> statement-breakpoint
CREATE TRIGGER subscription_deliveries_status BEFORE UPDATE ON subscription_deliveries
  FOR EACH ROW EXECUTE FUNCTION subscription_deliveries_status_trigger();--> statement-breakpoint
CREATE TRIGGER subscription_orders_delivery AFTER INSERT OR UPDATE OF status, order_id ON subscription_orders
  FOR EACH ROW EXECUTE FUNCTION subscription_orders_delivery_trigger();--> statement-breakpoint
CREATE TRIGGER orders_subscription_status AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (NEW.source = 'SUBSCRIPTION' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION orders_subscription_status_trigger();
