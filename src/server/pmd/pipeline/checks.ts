/**
 * Automated data-quality and duplicate checks.
 *
 * Invariants that must hold after ANY ingestion, whatever the source. They are SQL
 * assertions over the whole master, run by the pilot CLI, the test-suite and (in
 * production) after every batch - a failed check is an alert, not a log line.
 * Each check returns the offending rows so a steward can act on them.
 */
import type { Sql } from "../db";

export interface CheckResult {
  id: string;
  description: string;
  /** "INVARIANT" must always be 0. "REVIEW" are steward work-queues: findings are expected, not defects. */
  kind: "INVARIANT" | "REVIEW";
  violations: number;
  sample: Record<string, unknown>[];
}

interface CheckDef {
  id: string;
  description: string;
  kind: CheckResult["kind"];
  /** Query returning the offending rows. */
  sql: string;
}

const CHECKS: CheckDef[] = [
  {
    id: "unique-active-gtin",
    kind: "INVARIANT",
    description: "No two ACTIVE masters share a GTIN",
    sql: `SELECT gtin, count(*)::int AS masters FROM pmd.product_master WHERE record_status = 'ACTIVE' AND gtin IS NOT NULL GROUP BY gtin HAVING count(*) > 1`,
  },
  {
    id: "unique-master-id",
    kind: "INVARIANT",
    description: "MASTER_PRODUCT_ID is unique and well-formed",
    sql: `SELECT master_product_id FROM pmd.product_master WHERE master_product_id !~ '^GKS-PROD-[0-9]{9}$' OR master_product_id IN (SELECT master_product_id FROM pmd.product_master GROUP BY 1 HAVING count(*) > 1)`,
  },
  {
    id: "gtin-check-digit",
    kind: "INVARIANT",
    description: "Every stored GTIN is a 14-digit code with a valid GS1 check digit",
    sql: `WITH g AS (SELECT product_id, gtin, substr(gtin, 14, 1)::int AS cd,
              (SELECT sum(substr(gtin, i, 1)::int * CASE WHEN (14 - i) % 2 = 1 THEN 3 ELSE 1 END) FROM generate_series(1, 13) i) AS s
            FROM pmd.product_master WHERE gtin IS NOT NULL)
          SELECT product_id, gtin FROM g WHERE (10 - (s % 10)) % 10 <> cd`,
  },
  {
    id: "no-orphan-children",
    kind: "INVARIANT",
    description: "No offer, price-history or specification row points at a missing or retired product",
    sql: `SELECT 'offer' AS kind, offer_id AS id FROM pmd.product_offer o JOIN pmd.product_master m USING (product_id) WHERE m.record_status <> 'ACTIVE'
          UNION ALL SELECT 'history', price_history_id FROM pmd.price_history h JOIN pmd.product_master m USING (product_id) WHERE m.record_status <> 'ACTIVE'
          UNION ALL SELECT 'spec', spec_id FROM pmd.product_specification s JOIN pmd.product_master m USING (product_id) WHERE m.record_status <> 'ACTIVE'`,
  },
  {
    id: "one-preferred-spec",
    kind: "INVARIANT",
    description: "Every attribute of a product has exactly one preferred value",
    sql: `SELECT product_id, attribute_key, count(*) FILTER (WHERE is_preferred)::int AS preferred FROM pmd.product_specification GROUP BY 1, 2 HAVING count(*) FILTER (WHERE is_preferred) <> 1`,
  },
  {
    id: "sources-traceable",
    kind: "INVARIANT",
    description: "Every source record names its source, collection method and dates",
    sql: `SELECT product_source_id FROM pmd.product_source WHERE data_collection_method IS NULL OR first_seen_date IS NULL OR last_seen_date < first_seen_date`,
  },
  {
    id: "missing-is-null-not-zero",
    kind: "INVARIANT",
    description: "No zero or empty value stands in for missing data",
    sql: `SELECT product_id FROM pmd.product_master WHERE net_quantity_value = 0 OR net_weight_g = 0 OR pack_count = 0 OR btrim(product_name) = '' OR gst_rate_bp IS NOT DISTINCT FROM -1`,
  },
  {
    id: "no-price-on-master",
    kind: "INVARIANT",
    description: "Price and MRP are never stored on the product itself",
    sql: `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pmd' AND table_name = 'product_master' AND column_name ~ '(price|mrp|discount)'`,
  },
  {
    id: "history-covers-offers",
    kind: "INVARIANT",
    description: "Every offer has at least one price-history observation",
    sql: `SELECT o.offer_id FROM pmd.product_offer o WHERE NOT EXISTS (SELECT 1 FROM pmd.price_history h WHERE h.offer_id = o.offer_id)`,
  },
  {
    id: "no-discontinued-by-pipeline",
    kind: "INVARIANT",
    description: "No product is DISCONTINUED without a recorded human or manufacturer basis",
    sql: `SELECT product_id, status_basis FROM pmd.product_master WHERE product_status = 'DISCONTINUED' AND coalesce(status_basis, '') NOT IN ('MANUFACTURER_STATEMENT', 'MANUAL')`,
  },
  {
    id: "merged-have-target",
    kind: "INVARIANT",
    description: "Every MERGED product points at an ACTIVE survivor",
    sql: `SELECT f.product_id FROM pmd.product_master f LEFT JOIN pmd.product_master s ON s.product_id = f.merged_into_product_id WHERE f.record_status = 'MERGED' AND (s.product_id IS NULL OR s.record_status <> 'ACTIVE')`,
  },
  {
    id: "possible-duplicate-pairs",
    kind: "REVIEW",
    description: "Possible duplicates awaiting a person (never auto-merged)",
    sql: `SELECT mc.candidate_id, mc.match_score, mc.match_status FROM pmd.match_candidate mc WHERE mc.review_status = 'PENDING'`,
  },
  {
    id: "same-name-different-master",
    kind: "REVIEW",
    description: "Distinct ACTIVE masters with the same brand, core name and pack (suspicious duplicates the matcher kept apart)",
    sql: `SELECT brand_id, normalized_name, pack_size, count(*)::int AS masters FROM pmd.product_master
          WHERE record_status = 'ACTIVE' AND brand_id IS NOT NULL AND normalized_name <> '' AND pack_size IS NOT NULL
          GROUP BY 1, 2, 3 HAVING count(*) > 1`,
  },
  {
    id: "open-conflicts",
    kind: "REVIEW",
    description: "Specification conflicts between equally authoritative sources",
    sql: `SELECT conflict_id, product_id, attribute_key FROM pmd.product_attribute_conflict WHERE conflict_status = 'OPEN'`,
  },
  {
    id: "held-source-records",
    kind: "REVIEW",
    description: "Source records held because they could not be resolved automatically",
    sql: `SELECT product_source_id, source_product_id FROM pmd.product_source WHERE product_id IS NULL AND resolution = 'PENDING_REVIEW'`,
  },
  {
    id: "brand-looks-like-company",
    kind: "REVIEW",
    description: "Brands that read like legal entities (likely manufacturers filed as brands)",
    sql: `SELECT brand_id, brand_name FROM pmd.brand WHERE brand_name ~* '\\m(ltd|limited|pvt|private|llp|inc|corporation|industries|unilever|hul)\\M'`,
  },
];

export async function runChecks(sql: Sql, only?: CheckResult["kind"]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of CHECKS) {
    if (only && c.kind !== only) continue;
    const rows = await sql.unsafe<Record<string, unknown>[]>(c.sql);
    out.push({ id: c.id, description: c.description, kind: c.kind, violations: rows.length, sample: rows.slice(0, 5) });
  }
  return out;
}

/** Invariant failures only: what a deploy gate or an alert should look at. */
export async function failedInvariants(sql: Sql): Promise<CheckResult[]> {
  return (await runChecks(sql, "INVARIANT")).filter((c) => c.violations > 0);
}
