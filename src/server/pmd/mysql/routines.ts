/**
 * The three PMD routines that lived in the database on PostgreSQL.
 *
 * They are TypeScript here rather than stored routines, and that is forced
 * rather than chosen:
 *
 *   * `pmd.claim_job` returned `SETOF pmd.job`, and callers wrote
 *     `SELECT * FROM pmd.claim_job(...)`. A MySQL function returns one scalar
 *     and a MySQL procedure cannot appear in a FROM clause, so there is no
 *     spelling of that at all.
 *   * `pmd.refresh_dashboard` rebuilt a snapshot table in one statement using
 *     `count(*) FILTER (WHERE …)` and a `record` variable. Both are plpgsql.
 *   * `pmd.ensure_price_history_partitions` built `EXECUTE format(...)` DDL in a
 *     loop. MySQL permits no dynamic DDL inside a function at all.
 *
 * `pmd.touch_updated_at`, the fourth, needed no port: it was a trigger keeping
 * `updated_at` current, which MySQL does declaratively with
 * `ON UPDATE CURRENT_TIMESTAMP(3)` in the column definition.
 */
import type { Queryable, Sql } from "../db";
import { lockNames, pmdLock } from "./lock";

/* ------------------------------------------------------------- work queue */

export interface JobRow {
  job_id: number;
  job_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  payload: unknown;
}

/** 15 minutes, the default `p_stale` the Postgres function carried. */
const DEFAULT_STALE_SECONDS = 15 * 60;

/**
 * How many due jobs to look at before giving up on this round.
 *
 * Every one of them may be held by another worker, so this is effectively the
 * number of concurrent workers the queue tolerates before one goes away empty
 * while work remains. 64 is far above anything PMD runs.
 */
const CLAIM_CANDIDATES = 64;

/**
 * Claims one job of `types` for `worker`, or returns null if none is due.
 *
 * PostgreSQL did this in a single statement - a CTE selecting
 * `FOR UPDATE SKIP LOCKED LIMIT 1`, then an UPDATE driven by it - so the claim
 * was atomic for free. MySQL cannot drive an UPDATE from a locking SELECT in
 * one statement, so the two run inside one transaction, and the row lock held
 * until COMMIT is what stops a second worker claiming the same job.
 *
 * It picks the candidate with a **plain read** and then locks it **by primary
 * key**, rather than putting SKIP LOCKED on the ordered search directly. That
 * is not a stylistic choice. A locking range scan makes InnoDB lock the index
 * records it examines, and it examines them before the server applies the
 * LIMIT - so the first worker to arrive locks the whole pending range and every
 * other worker's SKIP LOCKED steps over all of it. Measured against MySQL
 * 8.0.46 with 12 free jobs and 8 workers, the direct form had **one** worker
 * claim anything and the other seven report no work. A primary-key lock takes
 * exactly one record, so all eight claim.
 *
 * The candidate read is therefore not authoritative - another worker may take
 * the row in between - so the locking read re-checks the claim conditions on
 * the row it actually holds, and moves to the next candidate if they no longer
 * hold. That re-check is what makes the plain read safe to start from.
 *
 * A job is due when it is PENDING, or RUNNING but its lock has gone stale -
 * which is how a worker that died mid-job gets retried.
 */
export async function claimJob(
  sql: Sql,
  types: readonly string[],
  worker: string,
  staleSeconds: number = DEFAULT_STALE_SECONDS,
): Promise<JobRow | null> {
  if (types.length === 0) return null;
  return sql.begin(async (tx) => {
    const candidates = await tx<{ job_id: number }[]>`
      SELECT job_id FROM pmd.job
      WHERE job_type IN ${tx(types)}
        AND run_after <= now()
        AND attempts < max_attempts
        AND (status = 'PENDING'
             OR (status = 'RUNNING' AND locked_at < now() - INTERVAL ${staleSeconds} SECOND))
      ORDER BY priority, run_after, job_id
      LIMIT ${CLAIM_CANDIDATES}`;

    for (const candidate of candidates) {
      // One row, by primary key: SKIP LOCKED here skips this job alone and
      // returns nothing if another worker holds it.
      const [held] = await tx<{ job_id: number; status: string; attempts: number; max_attempts: number; stale: number }[]>`
        SELECT job_id, status, attempts, max_attempts,
               (status = 'RUNNING' AND locked_at < now() - INTERVAL ${staleSeconds} SECOND) AS stale
          FROM pmd.job WHERE job_id = ${candidate.job_id}
          FOR UPDATE SKIP LOCKED`;
      if (!held) continue;
      // The row may have been claimed between the two reads; this read is a
      // current one, so these values are authoritative.
      const claimable =
        held.attempts < held.max_attempts && (held.status === "PENDING" || Boolean(held.stale));
      if (!claimable) continue;

      await tx`
        UPDATE pmd.job
           SET status = 'RUNNING', locked_by = ${worker}, locked_at = now(), attempts = attempts + 1
         WHERE job_id = ${held.job_id}`;
      const [row] = await tx<JobRow[]>`SELECT * FROM pmd.job WHERE job_id = ${held.job_id}`;
      return row ?? null;
    }
    return null;
  });
}

/* --------------------------------------------------------------- dashboard */

/** Above this many price rows an exact count is not worth it for a display tile. */
const PRICE_HISTORY_EXACT_LIMIT = 5_000_000;

/**
 * Rebuilds `pmd.dashboard_metric`.
 *
 * The shape of the original is kept: one pass over `product_master` for every
 * per-product number (it was a dozen scans once, 6-15s at a million products),
 * then the smaller or index-friendly ones. `count(*) FILTER (WHERE c)` becomes
 * `count(CASE WHEN c THEN 1 END)`, which counts the same rows because CASE
 * yields NULL when the condition is false and COUNT skips NULLs.
 *
 * Two runs finishing together must not both rebuild at once, or the second
 * insert collides on the primary key. The Postgres version took an advisory
 * lock for that; this takes the row lock that replaced advisory locks.
 */
export async function refreshDashboard(sql: Sql, windowDays = 7): Promise<void> {
  await sql.begin(async (tx) => {
    await lockNames(tx, [pmdLock("refresh_dashboard")]);
    await tx`DELETE FROM pmd.dashboard_metric`;

    const [a] = await tx<{
      total: number; new_p: number; upd_p: number; merged: number;
      m_gtin: number; m_brand: number; m_maker: number; m_cat: number;
      m_gst: number; m_hsn: number; avg_q: number;
    }[]>`
      SELECT count(CASE WHEN record_status = 'ACTIVE' THEN 1 END) AS total,
             count(CASE WHEN record_status = 'ACTIVE' AND created_at >= now() - INTERVAL ${windowDays} DAY THEN 1 END) AS new_p,
             count(CASE WHEN record_status = 'ACTIVE' AND created_at < now() - INTERVAL ${windowDays} DAY
                              AND updated_at >= now() - INTERVAL ${windowDays} DAY THEN 1 END) AS upd_p,
             count(CASE WHEN record_status = 'MERGED' THEN 1 END) AS merged,
             count(CASE WHEN record_status = 'ACTIVE' AND gtin IS NULL THEN 1 END) AS m_gtin,
             count(CASE WHEN record_status = 'ACTIVE' AND brand_id IS NULL THEN 1 END) AS m_brand,
             count(CASE WHEN record_status = 'ACTIVE' AND manufacturer_id IS NULL THEN 1 END) AS m_maker,
             count(CASE WHEN record_status = 'ACTIVE' AND category_id IS NULL THEN 1 END) AS m_cat,
             count(CASE WHEN record_status = 'ACTIVE' AND gst_rate_bp IS NULL THEN 1 END) AS m_gst,
             count(CASE WHEN record_status = 'ACTIVE' AND hsn_code IS NULL THEN 1 END) AS m_hsn,
             COALESCE(ROUND(AVG(CASE WHEN record_status = 'ACTIVE' AND data_quality_score IS NOT NULL
                                     THEN data_quality_score END), 2), 0) AS avg_q
        FROM pmd.product_master`;

    // price_history is the biggest table, and partitioned. Postgres summed
    // pg_class.reltuples across the partitions; information_schema.TABLES
    // carries InnoDB's own estimate, which is the same idea and as approximate.
    const [est] = await tx<{ n: number }[]>`
      SELECT COALESCE(SUM(TABLE_ROWS), 0) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = 'pmd' AND TABLE_NAME = 'price_history'`;
    let priceRows = est?.n ?? 0;
    if (priceRows <= PRICE_HISTORY_EXACT_LIMIT) {
      const [exact] = await tx<{ n: number }[]>`SELECT CAST(count(*) AS SIGNED) AS n FROM pmd.price_history`;
      priceRows = exact?.n ?? 0;
    }

    const scalars: [string, number][] = [
      ["total_products", a?.total ?? 0],
      ["new_products", a?.new_p ?? 0],
      ["updated_products", a?.upd_p ?? 0],
      ["duplicates_merged", a?.merged ?? 0],
      ["missing_gtin", a?.m_gtin ?? 0],
      ["missing_brand", a?.m_brand ?? 0],
      ["missing_manufacturer", a?.m_maker ?? 0],
      ["missing_category", a?.m_cat ?? 0],
      ["missing_gst", a?.m_gst ?? 0],
      ["missing_hsn", a?.m_hsn ?? 0],
      ["avg_quality_score", Number(a?.avg_q ?? 0)],
      ["price_observations", priceRows],
    ];

    const one = async (q: PromiseLike<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    scalars.push(
      ["possible_duplicates", await one(tx`
        SELECT CAST(count(DISTINCT product_source_id) AS SIGNED) AS n FROM pmd.match_candidate
        WHERE review_status = 'PENDING' AND match_status = 'POSSIBLE_MATCH'`)],
      ["manual_review", await one(tx`
        SELECT CAST(count(DISTINCT product_source_id) AS SIGNED) AS n FROM pmd.match_candidate
        WHERE review_status = 'PENDING' AND match_status IN ('POSSIBLE_MATCH','NEEDS_REVIEW')`)],
      // Products with no MRP anywhere, as an anti-join over the smaller set
      // that has one rather than a probe per product.
      ["missing_mrp", (a?.total ?? 0) - await one(tx`
        SELECT CAST(count(*) AS SIGNED) AS n FROM (
          SELECT product_id FROM pmd.product_offer  WHERE mrp_minor IS NOT NULL AND product_id IS NOT NULL
          UNION
          SELECT product_id FROM pmd.product_source WHERE source_mrp_minor IS NOT NULL AND product_id IS NOT NULL) h
        JOIN pmd.product_master pm ON pm.product_id = h.product_id AND pm.record_status = 'ACTIVE'`)],
      ["conflicting_specs", await one(tx`
        SELECT CAST(count(DISTINCT product_id) AS SIGNED) AS n FROM pmd.product_attribute_conflict
        WHERE conflict_status = 'OPEN'`)],
      ["source_records", await one(tx`SELECT CAST(count(*) AS SIGNED) AS n FROM pmd.product_source`)],
      ["offers", await one(tx`SELECT CAST(count(*) AS SIGNED) AS n FROM pmd.product_offer WHERE is_current`)],
      ["import_errors", await one(tx`SELECT CAST(count(*) AS SIGNED) AS n FROM pmd.import_error WHERE severity = 'ERROR'`)],
    );

    const rows: { metric: string; dimension: string; value: number }[] = scalars.map(([metric, value]) => ({
      metric,
      dimension: "",
      value,
    }));

    const byMarketplace = await tx<{ source_key: string; n: number }[]>`
      SELECT s.source_key, CAST(count(*) AS SIGNED) AS n
        FROM pmd.product_source ps JOIN pmd.source s USING (source_id) GROUP BY s.source_key`;
    for (const r of byMarketplace) rows.push({ metric: "by_marketplace", dimension: r.source_key, value: r.n });

    // `c.path_names[1]` indexed a text[]; path_names is json now, so the first
    // element comes out of a JSON path.
    const byCategory = await tx<{ dimension: string; n: number }[]>`
      SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(c.path_names, '$[0]')), '(uncategorised)') AS dimension,
             CAST(SUM(g.n) AS SIGNED) AS n
        FROM (SELECT category_id, count(*) AS n FROM pmd.product_master
               WHERE record_status = 'ACTIVE' GROUP BY category_id) g
        LEFT JOIN pmd.category c ON c.category_id = g.category_id
       GROUP BY dimension`;
    for (const r of byCategory) rows.push({ metric: "by_category", dimension: r.dimension, value: r.n });

    const byBrand = await tx<{ brand_name: string; n: number }[]>`
      SELECT COALESCE(b.brand_name, '(no brand)') AS brand_name, g.n
        FROM (SELECT brand_id, count(*) AS n FROM pmd.product_master
               WHERE record_status = 'ACTIVE' GROUP BY brand_id ORDER BY 2 DESC LIMIT 50) g
        LEFT JOIN pmd.brand b ON b.brand_id = g.brand_id`;
    for (const r of byBrand) rows.push({ metric: "by_brand", dimension: r.brand_name, value: r.n });

    if (rows.length) {
      await tx`INSERT INTO pmd.dashboard_metric ${tx(rows as never, "metric" as never, "dimension" as never, "value" as never)}`;
    }
  });
}

/* -------------------------------------------------------------- partitions */

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function partitionName(d: Date): string {
  return `p${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Makes sure `pmd.price_history` has a monthly partition for every month in
 * `[from, to]`, and returns how many it had to add.
 *
 * PostgreSQL attached a new partition to the parent. MySQL has no ATTACH:
 * every row is already in some partition, so the only way to add one is to
 * **reorganize** the catch-all `pmax` into the new month plus a fresh `pmax`.
 * That rewrites only the rows in pmax, and because the table is ordered by
 * `collected_at` in practice, early months are empty and the reorganisation is
 * cheap. It is still DDL, so this is not something to run per request.
 *
 * `REORGANIZE PARTITION` cannot be parameterised - partition names and range
 * bounds are syntax, not values - so the statement is assembled. Both
 * components are derived from a Date here and never from user input.
 */
export async function ensurePriceHistoryPartitions(sql: Queryable, from: Date, to: Date): Promise<number> {
  const existing = new Set(
    (
      await sql<{ PARTITION_NAME: string }[]>`
        SELECT PARTITION_NAME FROM information_schema.PARTITIONS
        WHERE TABLE_SCHEMA = 'pmd' AND TABLE_NAME = 'price_history' AND PARTITION_NAME IS NOT NULL`
    ).map((r) => r.PARTITION_NAME),
  );

  let made = 0;
  for (let d = monthStart(from); d <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const name = partitionName(d);
    if (existing.has(name)) continue;
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    if (!/^p\d{4}_\d{2}$/.test(name)) throw new Error(`refusing to build DDL for partition name ${name}`);
    await sql.unsafe(
      `ALTER TABLE pmd.price_history REORGANIZE PARTITION pmax INTO (
         PARTITION ${name} VALUES LESS THAN ('${isoDate(next)}'),
         PARTITION pmax VALUES LESS THAN (MAXVALUE))`,
    );
    existing.add(name);
    made += 1;
  }
  return made;
}
