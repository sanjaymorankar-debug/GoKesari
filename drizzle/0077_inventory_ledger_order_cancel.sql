-- Inventory & Accounting (docs/inventory-accounting-2026-10): a cancelled
-- order's restock is a SALE_RETURN of that order in the stock ledger.
-- cancelOrder() restocks through restockOnline(), whose inventory_movements row
-- carries no order_id, only the reason "Order <number> cancelled"; 0076's
-- trigger therefore recorded it as an ADJUSTMENT. The existing order code is
-- left unchanged: the trigger finds the order from that reason instead.
-- Rollback: scripts/rollback-0077.sql.
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
     AND qty_milli = NEW.delta_units::bigint * 1000
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
-- Cancellations recorded since 0076 went live.
UPDATE inv_stock_ledger l SET
  movement_type = 'SALE_RETURN',
  source_type = 'ORDER',
  source_id = o.id,
  order_id = o.id
  FROM orders o
 WHERE l.movement_type = 'ADJUSTMENT'
   AND l.order_id IS NULL
   AND l.inventory_movement_id IS NOT NULL
   AND l.qty_milli > 0
   AND l.note LIKE 'Order % cancelled'
   AND o.order_number = substring(l.note FROM '^Order (.+) cancelled$')
   AND o.shop_id = l.shop_id;
