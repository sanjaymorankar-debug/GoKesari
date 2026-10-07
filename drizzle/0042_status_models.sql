-- 0042 Lifecycle status models for shops, riders and subscriptions (feature F1).
-- Additive: each table keeps its existing status column with its existing
-- meaning. A new lifecycle_status column is DERIVED from those fields by a
-- BEFORE trigger on every insert/update, so no code path can leave it stale.
-- The same trigger is the single place transitions are checked (against
-- status_transition_rules, seeded from src/lib/status-models.ts) and logged
-- (status_changes, with the actor from the transient status_actor_id column).
-- Enforcement can be switched off without a deploy:
--   platform_settings key 'statusModels' -> {"enforceTransitions": false}
-- Rollback: scripts/rollback-0042.sql
CREATE TYPE "public"."rider_lifecycle_status" AS ENUM('ONBOARDING', 'OFFLINE', 'AVAILABLE', 'BUSY', 'ON_DELIVERY', 'SUSPENDED', 'REJECTED', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."shop_lifecycle_status" AS ENUM('PENDING', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'REJECTED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."subscription_lifecycle_status" AS ENUM('ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_transition_rules" (
	"entity_type" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "status_transition_rules_entity_type_from_status_to_status_pk" PRIMARY KEY("entity_type","from_status","to_status")
);
--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "lifecycle_status" "rider_lifecycle_status" DEFAULT 'ONBOARDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_partners" ADD COLUMN "status_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "lifecycle_status" "shop_lifecycle_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "status_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "lifecycle_status" "subscription_lifecycle_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "status_actor_id" uuid;--> statement-breakpoint
CREATE INDEX "status_changes_entity_idx" ON "status_changes" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "status_changes_created_idx" ON "status_changes" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO "status_transition_rules" ("entity_type","from_status","to_status") VALUES
  ('SHOP','PENDING','ACTIVE'),
  ('SHOP','PENDING','PAUSED'),
  ('SHOP','PENDING','REJECTED'),
  ('SHOP','PENDING','SUSPENDED'),
  ('SHOP','PENDING','CLOSED'),
  ('SHOP','ACTIVE','PAUSED'),
  ('SHOP','ACTIVE','SUSPENDED'),
  ('SHOP','ACTIVE','CLOSED'),
  ('SHOP','ACTIVE','PENDING'),
  ('SHOP','ACTIVE','REJECTED'),
  ('SHOP','PAUSED','ACTIVE'),
  ('SHOP','PAUSED','SUSPENDED'),
  ('SHOP','PAUSED','CLOSED'),
  ('SHOP','PAUSED','PENDING'),
  ('SHOP','PAUSED','REJECTED'),
  ('SHOP','SUSPENDED','ACTIVE'),
  ('SHOP','SUSPENDED','PAUSED'),
  ('SHOP','SUSPENDED','CLOSED'),
  ('SHOP','SUSPENDED','PENDING'),
  ('SHOP','SUSPENDED','REJECTED'),
  ('SHOP','REJECTED','PENDING'),
  ('SHOP','REJECTED','ACTIVE'),
  ('SHOP','REJECTED','PAUSED'),
  ('SHOP','REJECTED','CLOSED'),
  ('SHOP','CLOSED','PENDING'),
  ('SHOP','CLOSED','ACTIVE'),
  ('SHOP','CLOSED','PAUSED'),
  ('RIDER','ONBOARDING','OFFLINE'),
  ('RIDER','ONBOARDING','REJECTED'),
  ('RIDER','ONBOARDING','SUSPENDED'),
  ('RIDER','ONBOARDING','INACTIVE'),
  ('RIDER','REJECTED','ONBOARDING'),
  ('RIDER','REJECTED','OFFLINE'),
  ('RIDER','REJECTED','INACTIVE'),
  ('RIDER','OFFLINE','AVAILABLE'),
  ('RIDER','OFFLINE','BUSY'),
  ('RIDER','OFFLINE','ON_DELIVERY'),
  ('RIDER','OFFLINE','SUSPENDED'),
  ('RIDER','OFFLINE','INACTIVE'),
  ('RIDER','OFFLINE','ONBOARDING'),
  ('RIDER','OFFLINE','REJECTED'),
  ('RIDER','AVAILABLE','OFFLINE'),
  ('RIDER','AVAILABLE','BUSY'),
  ('RIDER','AVAILABLE','ON_DELIVERY'),
  ('RIDER','AVAILABLE','SUSPENDED'),
  ('RIDER','AVAILABLE','INACTIVE'),
  ('RIDER','BUSY','AVAILABLE'),
  ('RIDER','BUSY','OFFLINE'),
  ('RIDER','BUSY','ON_DELIVERY'),
  ('RIDER','BUSY','SUSPENDED'),
  ('RIDER','BUSY','INACTIVE'),
  ('RIDER','ON_DELIVERY','AVAILABLE'),
  ('RIDER','ON_DELIVERY','OFFLINE'),
  ('RIDER','ON_DELIVERY','BUSY'),
  ('RIDER','ON_DELIVERY','SUSPENDED'),
  ('RIDER','ON_DELIVERY','INACTIVE'),
  ('RIDER','SUSPENDED','OFFLINE'),
  ('RIDER','SUSPENDED','AVAILABLE'),
  ('RIDER','SUSPENDED','BUSY'),
  ('RIDER','SUSPENDED','ON_DELIVERY'),
  ('RIDER','SUSPENDED','INACTIVE'),
  ('RIDER','INACTIVE','OFFLINE'),
  ('RIDER','INACTIVE','ONBOARDING'),
  ('RIDER','INACTIVE','SUSPENDED'),
  ('SUBSCRIPTION','ACTIVE','PAUSED'),
  ('SUBSCRIPTION','ACTIVE','CANCELLED'),
  ('SUBSCRIPTION','ACTIVE','EXPIRED'),
  ('SUBSCRIPTION','PAUSED','ACTIVE'),
  ('SUBSCRIPTION','PAUSED','CANCELLED'),
  ('SUBSCRIPTION','PAUSED','EXPIRED')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle_shop(p_status shop_status, p_paused boolean, p_deleted timestamptz)
RETURNS shop_lifecycle_status LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_deleted IS NOT NULL THEN 'CLOSED'
    WHEN p_status = 'PENDING_APPROVAL' THEN 'PENDING'
    WHEN p_status = 'APPROVED' AND p_paused THEN 'PAUSED'
    WHEN p_status = 'APPROVED' THEN 'ACTIVE'
    WHEN p_status = 'SUSPENDED' THEN 'SUSPENDED'
    WHEN p_status = 'REJECTED' THEN 'REJECTED'
    ELSE 'CLOSED' END)::shop_lifecycle_status
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle_rider(p_id uuid, p_status delivery_partner_status, p_online boolean, p_deleted timestamptz)
RETURNS rider_lifecycle_status LANGUAGE plpgsql STABLE AS $$
DECLARE live text;
BEGIN
  IF p_deleted IS NOT NULL OR p_status = 'DEACTIVATED' THEN RETURN 'INACTIVE'; END IF;
  IF p_status IN ('REGISTERED', 'UNDER_REVIEW') THEN RETURN 'ONBOARDING'; END IF;
  IF p_status = 'REJECTED' THEN RETURN 'REJECTED'; END IF;
  IF p_status = 'SUSPENDED' THEN RETURN 'SUSPENDED'; END IF;
  SELECT d.status::text INTO live FROM delivery_orders d
   WHERE d.delivery_partner_id = p_id AND d.status IN ('OFFERED', 'ACCEPTED', 'PICKED_UP')
   ORDER BY (d.status = 'PICKED_UP') DESC LIMIT 1;
  IF live = 'PICKED_UP' THEN RETURN 'ON_DELIVERY'; END IF;
  IF live IS NOT NULL THEN RETURN 'BUSY'; END IF;
  IF p_online THEN RETURN 'AVAILABLE'; END IF;
  RETURN 'OFFLINE';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle_subscription(p_status subscription_status, p_from date, p_until date)
RETURNS subscription_lifecycle_status LANGUAGE plpgsql STABLE AS $$
DECLARE today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF p_status = 'CANCELLED' THEN RETURN 'CANCELLED'; END IF;
  IF p_status = 'COMPLETED' THEN RETURN 'EXPIRED'; END IF;
  IF p_status = 'PAUSED' THEN RETURN 'PAUSED'; END IF;
  IF p_from IS NOT NULL AND p_from <= today AND (p_until IS NULL OR p_until >= today) THEN RETURN 'PAUSED'; END IF;
  RETURN 'ACTIVE';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_lifecycle_change(p_entity text, p_id uuid, p_from text, p_to text, p_actor uuid, p_detail jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE enforce boolean;
BEGIN
  IF p_from IS NOT DISTINCT FROM p_to THEN RETURN; END IF;
  IF p_from IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM status_transition_rules r
     WHERE r.entity_type = p_entity AND r.from_status = p_from AND r.to_status = p_to) THEN
    SELECT COALESCE((value->>'enforceTransitions')::boolean, true) INTO enforce
      FROM platform_settings WHERE key = 'statusModels';
    IF COALESCE(enforce, true) THEN
      RAISE EXCEPTION 'Status change % -> % is not allowed for %', p_from, p_to, lower(p_entity)
        USING ERRCODE = 'check_violation', HINT = 'lifecycle_transition';
    END IF;
    p_detail := p_detail || '{"unenforced": true}'::jsonb;
  END IF;
  INSERT INTO status_changes (entity_type, entity_id, from_status, to_status, actor_id, detail)
  VALUES (p_entity, p_id, p_from, p_to, p_actor, p_detail);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shops_lifecycle_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.lifecycle_status := lifecycle_shop(NEW.status, NEW.orders_paused, NEW.deleted_at);
  PERFORM record_lifecycle_change('SHOP', NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.lifecycle_status::text END,
    NEW.lifecycle_status::text, NEW.status_actor_id,
    jsonb_build_object('status', NEW.status, 'orders_paused', NEW.orders_paused));
  NEW.status_actor_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delivery_partners_lifecycle_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.lifecycle_status := lifecycle_rider(NEW.id, NEW.status, NEW.is_online, NEW.deleted_at);
  PERFORM record_lifecycle_change('RIDER', NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.lifecycle_status::text END,
    NEW.lifecycle_status::text, NEW.status_actor_id,
    jsonb_build_object('status', NEW.status, 'is_online', NEW.is_online));
  NEW.status_actor_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subscriptions_lifecycle_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.lifecycle_status := lifecycle_subscription(NEW.status, NEW.pause_from, NEW.pause_until);
  PERFORM record_lifecycle_change('SUBSCRIPTION', NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.lifecycle_status::text END,
    NEW.lifecycle_status::text, NEW.status_actor_id,
    jsonb_build_object('status', NEW.status, 'pause_from', NEW.pause_from, 'pause_until', NEW.pause_until));
  NEW.status_actor_id := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A rider's live delivery changes its lifecycle (BUSY / ON_DELIVERY), so a
-- delivery-order change re-derives the rider by touching their row.
CREATE OR REPLACE FUNCTION delivery_orders_rider_lifecycle_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE delivery_partners SET status_actor_id = NULL
   WHERE id = NEW.delivery_partner_id
      OR (TG_OP = 'UPDATE' AND id = OLD.delivery_partner_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Existing records: derive their lifecycle now (triggers not yet installed, so
-- nothing is checked against the default), then log the starting point.
UPDATE shops SET lifecycle_status = lifecycle_shop(status, orders_paused, deleted_at);--> statement-breakpoint
UPDATE delivery_partners SET lifecycle_status = lifecycle_rider(id, status, is_online, deleted_at);--> statement-breakpoint
UPDATE subscriptions SET lifecycle_status = lifecycle_subscription(status, pause_from, pause_until);--> statement-breakpoint
INSERT INTO status_changes (entity_type, entity_id, from_status, to_status, detail)
  SELECT 'SHOP', id, NULL, lifecycle_status::text, jsonb_build_object('migration', '0042', 'status', status, 'orders_paused', orders_paused) FROM shops;--> statement-breakpoint
INSERT INTO status_changes (entity_type, entity_id, from_status, to_status, detail)
  SELECT 'RIDER', id, NULL, lifecycle_status::text, jsonb_build_object('migration', '0042', 'status', status, 'is_online', is_online) FROM delivery_partners;--> statement-breakpoint
INSERT INTO status_changes (entity_type, entity_id, from_status, to_status, detail)
  SELECT 'SUBSCRIPTION', id, NULL, lifecycle_status::text, jsonb_build_object('migration', '0042', 'status', status) FROM subscriptions;--> statement-breakpoint
DROP TRIGGER IF EXISTS shops_lifecycle ON shops;--> statement-breakpoint
CREATE TRIGGER shops_lifecycle BEFORE INSERT OR UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION shops_lifecycle_trigger();--> statement-breakpoint
DROP TRIGGER IF EXISTS delivery_partners_lifecycle ON delivery_partners;--> statement-breakpoint
CREATE TRIGGER delivery_partners_lifecycle BEFORE INSERT OR UPDATE ON delivery_partners
  FOR EACH ROW EXECUTE FUNCTION delivery_partners_lifecycle_trigger();--> statement-breakpoint
DROP TRIGGER IF EXISTS subscriptions_lifecycle ON subscriptions;--> statement-breakpoint
CREATE TRIGGER subscriptions_lifecycle BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_lifecycle_trigger();--> statement-breakpoint
DROP TRIGGER IF EXISTS delivery_orders_rider_lifecycle ON delivery_orders;--> statement-breakpoint
CREATE TRIGGER delivery_orders_rider_lifecycle AFTER INSERT OR UPDATE OF status, delivery_partner_id ON delivery_orders
  FOR EACH ROW EXECUTE FUNCTION delivery_orders_rider_lifecycle_trigger();
