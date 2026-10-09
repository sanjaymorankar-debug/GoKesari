-- GST rates and HSN codes as configured in the database — for the CA to check
-- (item D, pending CA verification). READ-ONLY: SELECTs only, safe on test or
-- production. Run with:
--   psql "$DATABASE_URL" -f scripts/gst-hsn-report.sql > gst-hsn-report.txt
--
-- How invoicing uses these (src/server/services/invoices.ts, rule `invoicing`):
--   * Prices are tax-inclusive; tax is taken out of each line at the
--     product's gst_rate_bp (basis points: 500 = 5 %).
--   * A product with no rate uses invoicing.defaultGstRateBp (code default 0)
--     and its invoice line says "rate not set".
--   * Shop with a verified GSTIN → tax invoice (CGST+SGST intra-state, IGST
--     inter-state); otherwise a bill of supply (no tax).
--   * GoKesari's delivery fee is NOT on the shop's invoice and has no SAC code
--     configured anywhere.

\echo '== 1. Rule invoicing (stored override; no row = code defaults enabled=false, defaultGstRateBp=0)'
SELECT key, value, updated_at FROM platform_settings WHERE key = 'invoicing';

\echo '== 2. Rates in use on live catalogue products (count by rate)'
SELECT COALESCE((gst_rate_bp / 100.0)::text || ' %', 'NOT SET') AS gst_rate,
       count(*) AS products
FROM products
WHERE deleted_at IS NULL
GROUP BY gst_rate_bp
ORDER BY gst_rate_bp NULLS FIRST;

\echo '== 3. HSN code x GST rate combinations (count, with an example product)'
SELECT COALESCE(hsn_code, 'NOT SET') AS hsn_code,
       COALESCE((gst_rate_bp / 100.0)::text || ' %', 'NOT SET') AS gst_rate,
       count(*) AS products,
       min(name) AS example_product
FROM products
WHERE deleted_at IS NULL
GROUP BY hsn_code, gst_rate_bp
ORDER BY hsn_code NULLS FIRST, gst_rate_bp NULLS FIRST;

\echo '== 4. Per product category: products missing a rate or an HSN code'
SELECT c.name AS category,
       count(*) AS products,
       count(*) FILTER (WHERE p.gst_rate_bp IS NULL) AS missing_rate,
       count(*) FILTER (WHERE p.hsn_code IS NULL) AS missing_hsn
FROM products p
JOIN product_categories c ON c.id = p.category_id
WHERE p.deleted_at IS NULL
GROUP BY c.name
ORDER BY c.name;

\echo '== 5. Products sold on GoKesari (listed by a shop) with their rate and HSN'
SELECT p.name, p.unit, COALESCE(p.hsn_code, 'NOT SET') AS hsn_code,
       COALESCE((p.gst_rate_bp / 100.0)::text || ' %', 'NOT SET') AS gst_rate,
       count(DISTINCT sp.shop_id) AS shops
FROM products p
JOIN shop_products sp ON sp.product_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.name, p.unit, p.hsn_code, p.gst_rate_bp
ORDER BY p.name;

\echo '== 6. Invoices already issued, by kind and tax'
SELECT kind, count(*) AS invoices
FROM tax_invoices
GROUP BY kind;
