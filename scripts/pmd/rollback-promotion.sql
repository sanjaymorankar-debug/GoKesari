-- Undo a bulk promotion: removes the catalogue products that pmd.catalogue_link created, but ONLY those no shop has
-- selected yet. Products shops already sell are left alone (and reported), so nothing a shop relies on disappears.
--
-- Rows are deleted, not soft-deleted: products_gtin_unique ignores deleted_at, so a soft-deleted product would keep
-- its GTIN and block promoting it again. The audit_logs rows stay (they are the record that it happened).
-- Brands the promotion created are left in place (unused brands are harmless); delete them by hand if you want them gone.
--
-- Usage:  psql "<target>" -v ON_ERROR_STOP=1 -f scripts/pmd/rollback-promotion.sql
-- Any other table that references a product makes the DELETE fail and the whole transaction roll back - by design.

BEGIN;

CREATE TEMP TABLE rollback_targets ON COMMIT DROP AS
  SELECT cl.product_id AS master_id, cl.catalogue_product_id AS catalogue_id
  FROM pmd.catalogue_link cl
  WHERE NOT EXISTS (SELECT 1 FROM public.shop_products sp WHERE sp.product_id = cl.catalogue_product_id);

SELECT (SELECT count(*) FROM pmd.catalogue_link) AS promoted_total,
       (SELECT count(*) FROM rollback_targets)   AS will_be_removed,
       (SELECT count(*) FROM pmd.catalogue_link) - (SELECT count(*) FROM rollback_targets) AS kept_because_a_shop_sells_them;

DELETE FROM pmd.catalogue_link       WHERE catalogue_product_id IN (SELECT catalogue_id FROM rollback_targets);
DELETE FROM public.product_images    WHERE product_id           IN (SELECT catalogue_id FROM rollback_targets);
DELETE FROM public.products          WHERE id                   IN (SELECT catalogue_id FROM rollback_targets);

COMMIT;
