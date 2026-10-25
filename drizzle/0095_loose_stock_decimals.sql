-- split: seller
-- D-95 (owner, 25 Oct 2026): loose stock records decimals. A listing's stock was
-- a whole number of sellable units, so 2.5 kg of a loose 1 kg listing was refused
-- (or a stock count of 2.500 kg left 2) and 250 g of it could not be sold. The
-- counts now keep three decimals — what the stock ledger already holds as
-- milli-units (qty_milli) — and the ledger triggers convert them exactly.
-- Packaged goods stay whole: the application refuses decimals for them.
-- The listing-update trigger names the two columns, so it is dropped for the
-- type change and created again at the end. Re-runnable: changing a column to
-- the type it already has does nothing, and the functions are replaced.
DROP TRIGGER IF EXISTS inv_ledger_listing_update ON shop_products;
--> statement-breakpoint
ALTER TABLE "shop_products" ALTER COLUMN "online_stock" TYPE numeric(14, 3);
--> statement-breakpoint
ALTER TABLE "shop_products" ALTER COLUMN "offline_stock" TYPE numeric(14, 3);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "delta_units" TYPE numeric(14, 3);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "previous_units" TYPE numeric(14, 3);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "new_units" TYPE numeric(14, 3);
--> statement-breakpoint
ALTER TABLE "stock_alerts" ALTER COLUMN "stock_at_alert" TYPE numeric(14, 3);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_listing_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  IF NEW.online_stock <> 0 THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'ONLINE', 'OPENING', round(NEW.online_stock * 1000)::bigint, 'CATALOGUE', txid_current(), 'Stock entered when the product was listed');
  END IF;
  IF NEW.offline_stock <> 0 THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'OFFLINE', 'OPENING', round(NEW.offline_stock * 1000)::bigint, 'CATALOGUE', txid_current(), 'Stock entered when the product was listed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_listing_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  IF NEW.online_stock IS DISTINCT FROM OLD.online_stock THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'ONLINE', 'ADJUSTMENT', round((NEW.online_stock - OLD.online_stock) * 1000)::bigint, 'CATALOGUE', txid_current(), 'Stock changed');
  END IF;
  IF NEW.offline_stock IS DISTINCT FROM OLD.offline_stock THEN
    INSERT INTO inv_stock_ledger (shop_id, shop_product_id, channel, movement_type, qty_milli, source_type, txid, note)
    VALUES (NEW.shop_id, NEW.id, 'OFFLINE', 'ADJUSTMENT', round((NEW.offline_stock - OLD.offline_stock) * 1000)::bigint, 'CATALOGUE', txid_current(), 'Stock changed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inv_ledger_on_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  linked_order uuid;
BEGIN
  IF inv_ledger_managed() THEN RETURN NEW; END IF;
  SELECT id INTO target FROM inv_stock_ledger
   WHERE shop_product_id = NEW.shop_product_id
     AND channel = NEW.channel
     AND txid = txid_current()
     AND inventory_movement_id IS NULL
     AND qty_milli = round(NEW.delta_units * 1000)::bigint
   ORDER BY created_at DESC, id DESC
   LIMIT 1;
  IF target IS NULL THEN RETURN NEW; END IF;
  linked_order := NEW.order_id;
  IF linked_order IS NULL AND NEW.delta_units > 0 AND NEW.reason LIKE 'Order % cancelled' THEN
    SELECT o.id INTO linked_order FROM orders o
      JOIN shop_products sp ON sp.id = NEW.shop_product_id AND sp.shop_id = o.shop_id
     WHERE o.order_number = substring(NEW.reason FROM '^Order (.+) cancelled$');
  END IF;
  UPDATE inv_stock_ledger SET
    movement_type = CASE
      WHEN linked_order IS NOT NULL AND NEW.delta_units < 0 THEN 'SALE'
      WHEN linked_order IS NOT NULL AND NEW.delta_units > 0 THEN 'SALE_RETURN'
      ELSE 'ADJUSTMENT' END,
    source_type = CASE WHEN linked_order IS NOT NULL THEN 'ORDER' ELSE 'CATALOGUE' END,
    source_id = linked_order,
    order_id = linked_order,
    inventory_movement_id = NEW.id,
    note = NEW.reason,
    created_by = NEW.created_by
  WHERE id = target;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inv_ledger_listing_update AFTER UPDATE OF online_stock, offline_stock ON shop_products FOR EACH ROW EXECUTE FUNCTION inv_ledger_on_listing_update();
