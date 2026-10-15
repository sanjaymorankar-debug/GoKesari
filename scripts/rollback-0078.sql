-- Rollback for 0078_inventory_ledger_order_cancel (docs/inventory-accounting-2026-10).
-- Puts back 0076's ledger trigger function. Rows already marked SALE_RETURN
-- keep that label (the stock quantities are the same either way).
-- Then delete the 0078 row from drizzle.__drizzle_migrations.
BEGIN;
CREATE OR REPLACE FUNCTION inv_ledger_on_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
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
  UPDATE inv_stock_ledger SET
    movement_type = CASE
      WHEN NEW.order_id IS NOT NULL AND NEW.delta_units < 0 THEN 'SALE'
      WHEN NEW.order_id IS NOT NULL AND NEW.delta_units > 0 THEN 'SALE_RETURN'
      ELSE 'ADJUSTMENT' END,
    source_type = CASE WHEN NEW.order_id IS NOT NULL THEN 'ORDER' ELSE 'CATALOGUE' END,
    source_id = NEW.order_id,
    order_id = NEW.order_id,
    inventory_movement_id = NEW.id,
    note = NEW.reason,
    created_by = NEW.created_by
  WHERE id = target;
  RETURN NEW;
END $$;
COMMIT;
