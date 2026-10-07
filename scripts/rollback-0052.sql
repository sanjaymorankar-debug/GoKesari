-- Reverses drizzle/0052_subscription_states.sql (SM-004). Run only after no
-- subscription is DRAFT or RENEWAL_PENDING (this script moves them: DRAFT ->
-- CANCELLED, RENEWAL_PENDING -> ACTIVE). Postgres cannot drop enum values, so
-- subscription_status keeps DRAFT/RENEWAL_PENDING as unused labels.
-- Back up first: this drops the per-delivery status table. Afterwards delete
-- the 0052 row from drizzle.__drizzle_migrations.
BEGIN;
DROP TRIGGER IF EXISTS orders_subscription_status ON orders;
DROP TRIGGER IF EXISTS subscription_orders_delivery ON subscription_orders;
DROP TRIGGER IF EXISTS subscription_deliveries_status ON subscription_deliveries;
DROP FUNCTION IF EXISTS orders_subscription_status_trigger();
DROP FUNCTION IF EXISTS subscription_orders_delivery_trigger();
DROP FUNCTION IF EXISTS subscription_deliveries_status_trigger();
DROP FUNCTION IF EXISTS subscription_delivery_transition_ok(text, text);
DROP TABLE IF EXISTS subscription_deliveries;
DROP TYPE IF EXISTS subscription_delivery_status;

UPDATE subscriptions SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'Draft removed by rollback 0052'
 WHERE status::text = 'DRAFT';
UPDATE subscriptions SET status = 'ACTIVE' WHERE status::text = 'RENEWAL_PENDING';
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_renewal_reason_valid;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS renewal_reason, DROP COLUMN IF EXISTS renewal_due_date;

-- Lifecycle back to the 0042 set.
DROP TRIGGER IF EXISTS subscriptions_lifecycle ON subscriptions;
ALTER TABLE subscriptions ALTER COLUMN lifecycle_status DROP DEFAULT;
ALTER TABLE subscriptions ALTER COLUMN lifecycle_status SET DATA TYPE text;
DROP FUNCTION IF EXISTS lifecycle_subscription(subscription_status, date, date);
DROP TYPE subscription_lifecycle_status;
CREATE TYPE subscription_lifecycle_status AS ENUM('ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED');
UPDATE subscriptions SET lifecycle_status = 'CANCELLED' WHERE lifecycle_status = 'DRAFT';
UPDATE subscriptions SET lifecycle_status = 'ACTIVE' WHERE lifecycle_status = 'RENEWAL_PENDING';
ALTER TABLE subscriptions ALTER COLUMN lifecycle_status SET DATA TYPE subscription_lifecycle_status USING lifecycle_status::subscription_lifecycle_status;
ALTER TABLE subscriptions ALTER COLUMN lifecycle_status SET DEFAULT 'ACTIVE';
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
DELETE FROM status_transition_rules WHERE entity_type = 'SUBSCRIPTION';
INSERT INTO status_transition_rules (entity_type, from_status, to_status) VALUES
  ('SUBSCRIPTION','ACTIVE','PAUSED'),
  ('SUBSCRIPTION','ACTIVE','CANCELLED'),
  ('SUBSCRIPTION','ACTIVE','EXPIRED'),
  ('SUBSCRIPTION','PAUSED','ACTIVE'),
  ('SUBSCRIPTION','PAUSED','CANCELLED'),
  ('SUBSCRIPTION','PAUSED','EXPIRED')
ON CONFLICT DO NOTHING;
CREATE TRIGGER subscriptions_lifecycle BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_lifecycle_trigger();
COMMIT;
