-- Undo a bulk promotion.
--
--   * A catalogue product that promotion CREATED (audit row 'pmd.product_promoted') is deleted, unless a shop has
--     already selected it - those are reported and kept, so nothing a shop sells disappears.
--   * A catalogue product that promotion only ADOPTED (an existing product with the same GTIN, audit row
--     'pmd.product_adopted') is never touched: only its link to the master product is removed.
--
-- Rows are deleted, not soft-deleted: products_gtin_unique ignores deleted_at, so a soft-deleted product would keep
-- its GTIN and block promoting it again. The audit_logs rows stay (they are the record that it happened).
-- Brands the promotion created are left in place (unused brands are harmless); delete them by hand if you want them gone.
--
-- Usage:  psql -v ON_ERROR_STOP=1 -f scripts/pmd/rollback-promotion.sql "<target>"
-- Any other table that references a product makes the DELETE fail and the whole transaction roll back - by design.

BEGIN;

CREATE TEMP TABLE rollback_targets ON COMMIT DROP AS
  SELECT cl.catalogue_product_id AS catalogue_id,
         EXISTS (SELECT 1 FROM public.audit_logs a
                 WHERE a.action = 'pmd.product_promoted' AND a.entity_type = 'product' AND a.entity_id = cl.catalogue_product_id::text) AS created_by_promotion,
         EXISTS (SELECT 1 FROM public.shop_products sp WHERE sp.product_id = cl.catalogue_product_id) AS sold_by_a_shop
  FROM pmd.catalogue_link cl;

SELECT count(*)                                                        AS linked_total,
       count(*) FILTER (WHERE created_by_promotion AND NOT sold_by_a_shop) AS products_deleted,
       count(*) FILTER (WHERE NOT created_by_promotion)                AS adopted_links_removed_product_kept,
       count(*) FILTER (WHERE created_by_promotion AND sold_by_a_shop) AS kept_because_a_shop_sells_them
FROM rollback_targets;

-- links: everything except products a shop sells that promotion created (their lineage stays)
DELETE FROM pmd.catalogue_link
 WHERE catalogue_product_id IN (SELECT catalogue_id FROM rollback_targets WHERE NOT (created_by_promotion AND sold_by_a_shop));

DELETE FROM public.product_images
 WHERE product_id IN (SELECT catalogue_id FROM rollback_targets WHERE created_by_promotion AND NOT sold_by_a_shop);

DELETE FROM public.products
 WHERE id IN (SELECT catalogue_id FROM rollback_targets WHERE created_by_promotion AND NOT sold_by_a_shop);

COMMIT;
