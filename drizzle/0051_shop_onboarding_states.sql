-- 0051 SM-002: shop onboarding stages. The single F1 lifecycle stage PENDING
-- is replaced by KYC_PENDING -> PAYMENT_PENDING -> VERIFIED, derived (like the
-- rest of the lifecycle) by the shops trigger, now from seller documents and
-- the registration fee as well:
--   KYC_PENDING      a mandatory seller document is not VERIFIED
--                    (PAN, GSTIN or a reviewed no-GST declaration, Shop Act,
--                    and FSSAI for food businesses - requirementFor() in
--                    seller-verification-checks.ts; SQL: shop_kyc_complete)
--   PAYMENT_PENDING  documents verified, fee_payment_status <> PAID
--   VERIFIED         both done; waiting for an operator to approve
-- Only VERIFIED may go ACTIVE (status_transition_rules). A change to a shop's
-- documents or categories re-derives the shop, so the stage is never stale.
-- Existing PENDING shops are mapped to their stage from their documents and
-- fee, and each move is logged in status_changes (detail.migration = 0051).
-- Rollback: scripts/rollback-0051.sql
DROP TRIGGER IF EXISTS shops_lifecycle ON shops;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "lifecycle_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "lifecycle_status" SET DATA TYPE text;--> statement-breakpoint
DROP FUNCTION IF EXISTS lifecycle_shop(shop_status, boolean, timestamptz);--> statement-breakpoint
DROP TYPE "public"."shop_lifecycle_status";--> statement-breakpoint
CREATE TYPE "public"."shop_lifecycle_status" AS ENUM('KYC_PENDING', 'PAYMENT_PENDING', 'VERIFIED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'REJECTED', 'CLOSED');--> statement-breakpoint
-- Food businesses need FSSAI. Mirrors shopSellsFood(): a food shop type, or
-- any category in a food department. The list is FOOD_SHOP_TYPE_KEYS
-- (lib/shop-types.ts); tests/integration/shop-onboarding-states.test.ts keeps them equal.
CREATE OR REPLACE FUNCTION shop_sells_food(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_type = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE'])
      OR EXISTS (
        SELECT 1 FROM shop_product_categories spc
          JOIN product_categories pc ON pc.id = spc.category_id
         WHERE spc.shop_id = p_shop
           AND pc.department::text = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE']))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_kyc_complete(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM unnest(ARRAY['PAN', 'GSTIN', 'SHOP_ACT']
                  || CASE WHEN shop_sells_food(p_shop, p_type) THEN ARRAY['FSSAI'] ELSE ARRAY[]::text[] END) AS req(doc)
     WHERE NOT EXISTS (
       SELECT 1 FROM seller_verifications v
        WHERE v.shop_id = p_shop AND v.doc_type::text = req.doc AND v.status = 'VERIFIED'))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION lifecycle_shop(p_status shop_status, p_paused boolean, p_deleted timestamptz,
                                          p_fee fee_payment_status, p_kyc boolean)
RETURNS shop_lifecycle_status LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE
    WHEN p_deleted IS NOT NULL THEN 'CLOSED'
    WHEN p_status = 'PENDING_APPROVAL' AND NOT p_kyc THEN 'KYC_PENDING'
    WHEN p_status = 'PENDING_APPROVAL' AND p_fee <> 'PAID' THEN 'PAYMENT_PENDING'
    WHEN p_status = 'PENDING_APPROVAL' THEN 'VERIFIED'
    WHEN p_status = 'APPROVED' AND p_paused THEN 'PAUSED'
    WHEN p_status = 'APPROVED' THEN 'ACTIVE'
    WHEN p_status = 'SUSPENDED' THEN 'SUSPENDED'
    WHEN p_status = 'REJECTED' THEN 'REJECTED'
    ELSE 'CLOSED' END)::shop_lifecycle_status
$$;--> statement-breakpoint
-- Documents only matter while a shop awaits approval, so the lookup is skipped otherwise.
CREATE OR REPLACE FUNCTION shop_lifecycle_of(p_shop shops)
RETURNS shop_lifecycle_status LANGUAGE sql STABLE AS $$
  SELECT lifecycle_shop(p_shop.status, p_shop.orders_paused, p_shop.deleted_at, p_shop.fee_payment_status,
    CASE WHEN p_shop.status = 'PENDING_APPROVAL' AND p_shop.deleted_at IS NULL
         THEN shop_kyc_complete(p_shop.id, p_shop.shop_type::text) ELSE false END)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION shops_lifecycle_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.lifecycle_status := shop_lifecycle_of(NEW);
  PERFORM record_lifecycle_change('SHOP', NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.lifecycle_status::text END,
    NEW.lifecycle_status::text, NEW.status_actor_id,
    jsonb_build_object('status', NEW.status, 'orders_paused', NEW.orders_paused,
                       'fee_payment_status', NEW.fee_payment_status));
  NEW.status_actor_id := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- A seller document or a category link changing can move a pending shop's stage:
-- touch the shop so its trigger re-derives it (same pattern as delivery_orders -> riders).
CREATE OR REPLACE FUNCTION shop_onboarding_touch_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shops SET status_actor_id = NULL
   WHERE status = 'PENDING_APPROVAL'
     AND id IN (CASE WHEN TG_OP <> 'DELETE' THEN NEW.shop_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.shop_id END);
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- Existing shops: map, then log every shop that left the old PENDING stage.
INSERT INTO status_changes (entity_type, entity_id, from_status, to_status, detail)
  SELECT 'SHOP', s.id, 'PENDING', shop_lifecycle_of(s)::text,
         jsonb_build_object('migration', '0051', 'status', s.status, 'fee_payment_status', s.fee_payment_status)
    FROM shops s WHERE s.lifecycle_status = 'PENDING';--> statement-breakpoint
UPDATE shops s SET lifecycle_status = shop_lifecycle_of(s)::text;--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "lifecycle_status" SET DATA TYPE "public"."shop_lifecycle_status" USING "lifecycle_status"::"public"."shop_lifecycle_status";--> statement-breakpoint
ALTER TABLE "shops" ALTER COLUMN "lifecycle_status" SET DEFAULT 'KYC_PENDING'::"public"."shop_lifecycle_status";--> statement-breakpoint
DELETE FROM status_transition_rules WHERE entity_type = 'SHOP';--> statement-breakpoint
INSERT INTO "status_transition_rules" ("entity_type","from_status","to_status") VALUES
  ('SHOP','KYC_PENDING','PAYMENT_PENDING'),
  ('SHOP','KYC_PENDING','VERIFIED'),
  ('SHOP','KYC_PENDING','REJECTED'),
  ('SHOP','KYC_PENDING','SUSPENDED'),
  ('SHOP','KYC_PENDING','CLOSED'),
  ('SHOP','PAYMENT_PENDING','KYC_PENDING'),
  ('SHOP','PAYMENT_PENDING','VERIFIED'),
  ('SHOP','PAYMENT_PENDING','REJECTED'),
  ('SHOP','PAYMENT_PENDING','SUSPENDED'),
  ('SHOP','PAYMENT_PENDING','CLOSED'),
  ('SHOP','VERIFIED','KYC_PENDING'),
  ('SHOP','VERIFIED','PAYMENT_PENDING'),
  ('SHOP','VERIFIED','ACTIVE'),
  ('SHOP','VERIFIED','PAUSED'),
  ('SHOP','VERIFIED','REJECTED'),
  ('SHOP','VERIFIED','SUSPENDED'),
  ('SHOP','VERIFIED','CLOSED'),
  ('SHOP','ACTIVE','PAUSED'),
  ('SHOP','ACTIVE','SUSPENDED'),
  ('SHOP','ACTIVE','CLOSED'),
  ('SHOP','ACTIVE','KYC_PENDING'),
  ('SHOP','ACTIVE','PAYMENT_PENDING'),
  ('SHOP','ACTIVE','VERIFIED'),
  ('SHOP','ACTIVE','REJECTED'),
  ('SHOP','PAUSED','ACTIVE'),
  ('SHOP','PAUSED','SUSPENDED'),
  ('SHOP','PAUSED','CLOSED'),
  ('SHOP','PAUSED','KYC_PENDING'),
  ('SHOP','PAUSED','PAYMENT_PENDING'),
  ('SHOP','PAUSED','VERIFIED'),
  ('SHOP','PAUSED','REJECTED'),
  ('SHOP','SUSPENDED','ACTIVE'),
  ('SHOP','SUSPENDED','PAUSED'),
  ('SHOP','SUSPENDED','CLOSED'),
  ('SHOP','SUSPENDED','KYC_PENDING'),
  ('SHOP','SUSPENDED','PAYMENT_PENDING'),
  ('SHOP','SUSPENDED','VERIFIED'),
  ('SHOP','SUSPENDED','REJECTED'),
  ('SHOP','REJECTED','KYC_PENDING'),
  ('SHOP','REJECTED','PAYMENT_PENDING'),
  ('SHOP','REJECTED','VERIFIED'),
  ('SHOP','REJECTED','ACTIVE'),
  ('SHOP','REJECTED','PAUSED'),
  ('SHOP','REJECTED','CLOSED'),
  ('SHOP','CLOSED','KYC_PENDING'),
  ('SHOP','CLOSED','PAYMENT_PENDING'),
  ('SHOP','CLOSED','VERIFIED'),
  ('SHOP','CLOSED','ACTIVE'),
  ('SHOP','CLOSED','PAUSED')
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE TRIGGER shops_lifecycle BEFORE INSERT OR UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION shops_lifecycle_trigger();--> statement-breakpoint
DROP TRIGGER IF EXISTS seller_verifications_shop_onboarding ON seller_verifications;--> statement-breakpoint
CREATE TRIGGER seller_verifications_shop_onboarding AFTER INSERT OR UPDATE OF status OR DELETE ON seller_verifications
  FOR EACH ROW EXECUTE FUNCTION shop_onboarding_touch_trigger();--> statement-breakpoint
DROP TRIGGER IF EXISTS shop_product_categories_shop_onboarding ON shop_product_categories;--> statement-breakpoint
CREATE TRIGGER shop_product_categories_shop_onboarding AFTER INSERT OR DELETE ON shop_product_categories
  FOR EACH ROW EXECUTE FUNCTION shop_onboarding_touch_trigger();
