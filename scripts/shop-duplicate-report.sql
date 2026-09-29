-- Duplicate shop report — READ ONLY.
--
-- Lists groups of shops that look like the same shop registered more than
-- once, with their ids, statuses and created dates. Nothing is updated or
-- deleted: pick the record to keep in each group yourself.
--
-- Run it in the Neon SQL editor, or from a checkout:
--   DATABASE_URL=<target> npx tsx scripts/shop-duplicate-report.ts [--csv]
--
-- Groups (one shop can appear in several):
--   SHOP_ACT      same Shop Act / Gumasta licence (compared on letters and digits only)
--   UDYAM         same Udyam / Udyog Aadhaar number
--   PAN           same PAN, compared by pan_hash. PANs submitted before migration 0024
--                 have no pan_hash until scripts/backfill-shop-pan-hash.ts is run.
--   NAME_AND_PIN  same shop name (case, spaces and punctuation ignored) at the same
--                 PIN code. The only grouping that finds shops registered before these
--                 numbers were collected. A heuristic: two genuinely different shops
--                 can share a name inside one PIN code, so check owner and address.
--
-- A group sharing a PAN or Udyam number can be several genuine branches of one
-- business — the registration check only treats those as duplicates at the same
-- place. Soft-deleted shops are left out. PANs are shown masked.
--
-- Runs before migration 0024 too (e.g. on a database still at 0014): the new
-- columns are read through to_jsonb(), come back NULL, and only NAME_AND_PIN
-- applies.
WITH base AS (
  SELECT
    s.id,
    s.registration_number,
    s.name,
    s.owner_id,
    s.owner_name,
    s.address_line1,
    s.pincode,
    s.status,
    s.created_at,
    to_jsonb(s) ->> 'shop_act_key' AS shop_act_key,
    to_jsonb(s) ->> 'udyam_number' AS udyam_number,
    to_jsonb(s) ->> 'pan_hash' AS pan_hash,
    s.pan_last4,
    regexp_replace(lower(s.name), '[^[:alnum:]]+', '', 'g') AS name_key
  FROM shops s
  WHERE s.deleted_at IS NULL
),
keyed AS (
  SELECT 'SHOP_ACT' AS matched_on, b.shop_act_key AS group_key, b.* FROM base b
  WHERE b.shop_act_key IS NOT NULL
  UNION ALL
  SELECT 'UDYAM', b.udyam_number, b.* FROM base b
  WHERE b.udyam_number IS NOT NULL
  UNION ALL
  SELECT 'PAN', b.pan_hash, b.* FROM base b
  WHERE b.pan_hash IS NOT NULL
  UNION ALL
  SELECT 'NAME_AND_PIN', b.name_key || '|' || b.pincode, b.* FROM base b
  WHERE b.name_key <> ''
),
grouped AS (
  SELECT k.*, count(*) OVER (PARTITION BY k.matched_on, k.group_key) AS group_size
  FROM keyed k
)
SELECT
  dense_rank() OVER (ORDER BY g.matched_on, g.group_key) AS group_no,
  g.matched_on,
  CASE g.matched_on
    WHEN 'PAN' THEN 'XXXXXX' || coalesce(g.pan_last4, '????')
    WHEN 'NAME_AND_PIN' THEN g.name || ' / ' || g.pincode
    ELSE 'ending ' || right(g.group_key, 4)
  END AS matched_value,
  g.group_size,
  g.id AS shop_id,
  g.registration_number,
  g.name AS shop_name,
  g.owner_name,
  g.owner_id,
  g.address_line1,
  g.status,
  g.created_at
FROM grouped g
WHERE g.group_size > 1
ORDER BY group_no, g.created_at;
