-- Reverses drizzle/0042_status_models.sql. Existing status columns are untouched
-- by 0042, so nothing else needs restoring. Back up first: this drops the
-- lifecycle change log. Afterwards delete the 0042 row from drizzle.__drizzle_migrations.
DROP TRIGGER IF EXISTS delivery_orders_rider_lifecycle ON delivery_orders;
DROP TRIGGER IF EXISTS subscriptions_lifecycle ON subscriptions;
DROP TRIGGER IF EXISTS delivery_partners_lifecycle ON delivery_partners;
DROP TRIGGER IF EXISTS shops_lifecycle ON shops;
DROP FUNCTION IF EXISTS delivery_orders_rider_lifecycle_trigger();
DROP FUNCTION IF EXISTS subscriptions_lifecycle_trigger();
DROP FUNCTION IF EXISTS delivery_partners_lifecycle_trigger();
DROP FUNCTION IF EXISTS shops_lifecycle_trigger();
DROP FUNCTION IF EXISTS record_lifecycle_change(text, uuid, text, text, uuid, jsonb);
DROP FUNCTION IF EXISTS lifecycle_subscription(subscription_status, date, date);
DROP FUNCTION IF EXISTS lifecycle_rider(uuid, delivery_partner_status, boolean, timestamptz);
DROP FUNCTION IF EXISTS lifecycle_shop(shop_status, boolean, timestamptz);
ALTER TABLE subscriptions DROP COLUMN IF EXISTS status_actor_id, DROP COLUMN IF EXISTS lifecycle_status;
ALTER TABLE delivery_partners DROP COLUMN IF EXISTS status_actor_id, DROP COLUMN IF EXISTS lifecycle_status;
ALTER TABLE shops DROP COLUMN IF EXISTS status_actor_id, DROP COLUMN IF EXISTS lifecycle_status;
DROP TABLE IF EXISTS status_transition_rules;
DROP TABLE IF EXISTS status_changes;
DROP TYPE IF EXISTS subscription_lifecycle_status;
DROP TYPE IF EXISTS rider_lifecycle_status;
DROP TYPE IF EXISTS shop_lifecycle_status;
