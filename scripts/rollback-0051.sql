-- Reverses drizzle/0051_shop_onboarding_states.sql (SM-002): the three
-- onboarding stages fold back into F1's single PENDING stage, and the 0042
-- shop function, trigger and transition rules come back. Shop status, fee and
-- documents are untouched by 0051, so nothing else needs restoring. The change
-- log keeps its 0051-era rows (text values). Afterwards delete the 0051 row
-- from drizzle.__drizzle_migrations.
BEGIN;
DROP TRIGGER IF EXISTS shop_product_categories_shop_onboarding ON shop_product_categories;
DROP TRIGGER IF EXISTS seller_verifications_shop_onboarding ON seller_verifications;
DROP TRIGGER IF EXISTS shops_lifecycle ON shops;
DROP FUNCTION IF EXISTS shop_onboarding_touch_trigger();
ALTER TABLE shops ALTER COLUMN lifecycle_status DROP DEFAULT;
ALTER TABLE shops ALTER COLUMN lifecycle_status SET DATA TYPE text;
DROP FUNCTION IF EXISTS shop_lifecycle_of(shops);
DROP FUNCTION IF EXISTS lifecycle_shop(shop_status, boolean, timestamptz, fee_payment_status, boolean);
DROP FUNCTION IF EXISTS shop_kyc_complete(uuid, text);
DROP FUNCTION IF EXISTS shop_sells_food(uuid, text);
DROP TYPE shop_lifecycle_status;
CREATE TYPE shop_lifecycle_status AS ENUM('PENDING', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'REJECTED', 'CLOSED');
UPDATE shops SET lifecycle_status = 'PENDING' WHERE lifecycle_status IN ('KYC_PENDING', 'PAYMENT_PENDING', 'VERIFIED');
ALTER TABLE shops ALTER COLUMN lifecycle_status SET DATA TYPE shop_lifecycle_status USING lifecycle_status::shop_lifecycle_status;
ALTER TABLE shops ALTER COLUMN lifecycle_status SET DEFAULT 'PENDING';
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
DELETE FROM status_transition_rules WHERE entity_type = 'SHOP';
INSERT INTO status_transition_rules (entity_type, from_status, to_status) VALUES
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
  ('SHOP','CLOSED','PAUSED')
ON CONFLICT DO NOTHING;
CREATE TRIGGER shops_lifecycle BEFORE INSERT OR UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION shops_lifecycle_trigger();
COMMIT;
