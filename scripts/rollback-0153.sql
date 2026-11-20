-- Rollback of 0153_puja_samagri_schema.sql and 0154_puja_samagri_catalogue.sql (run by hand,
-- in this order, only if the Puja Samagri feature must be removed). Shops' puja listings and
-- past orders point at the seeded products, so the products themselves are retired, not deleted.
BEGIN;

CREATE OR REPLACE FUNCTION shop_sells_food(p_shop uuid, p_type text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_type = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE'])
      OR EXISTS (SELECT 1 FROM shop_types st WHERE st.key = p_type AND st.is_food)
      OR EXISTS (
        SELECT 1 FROM shop_product_categories spc
          JOIN product_categories pc ON pc.id = spc.category_id
         WHERE spc.shop_id = p_shop
           AND (pc.department = ANY (ARRAY['GROCERY_KIRANA', 'SUPERMARKET', 'CONVENIENCE_STORE', 'FRUIT_VEGETABLE', 'DAIRY', 'BAKERY', 'MEAT_SHOP', 'SWEET_SHOP', 'POULTRY_SUPPLY', 'RESTAURANT', 'FAST_FOOD', 'CAFE'])
                OR EXISTS (SELECT 1 FROM shop_types st WHERE st.key = pc.department AND st.is_food)))
$$;

-- 0154: switch the type off and retire the seeded catalogue (rows stay for order history).
UPDATE shop_types SET status = 'INACTIVE', updated_at = now() WHERE key = 'PUJA_SAMAGRI';
UPDATE products SET is_active = false
 WHERE id IN (SELECT product_id FROM product_catalogue_attrs WHERE catalogue = 'PUJA_SAMAGRI');
UPDATE product_categories SET is_active = false, updated_at = now() WHERE department = 'PUJA_SAMAGRI';

-- 0153: tables and columns.
DROP TABLE IF EXISTS festival_collections;
DROP TABLE IF EXISTS listing_price_requests;
DROP TABLE IF EXISTS shop_added_types;
DROP TABLE IF EXISTS product_catalogue_attrs;
DROP TABLE IF EXISTS product_local_names;
ALTER TABLE product_subcategories
  DROP CONSTRAINT IF EXISTS product_subcategories_approval_known,
  DROP COLUMN IF EXISTS merged_into_id,
  DROP COLUMN IF EXISTS review_note,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS is_edible,
  DROP COLUMN IF EXISTS is_perishable,
  DROP COLUMN IF EXISTS is_loose,
  DROP COLUMN IF EXISTS variant_attributes,
  DROP COLUMN IF EXISTS default_unit,
  DROP COLUMN IF EXISTS approval_status,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS owner_shop_id,
  DROP COLUMN IF EXISTS name_mr,
  DROP COLUMN IF EXISTS name_hi;

COMMIT;
