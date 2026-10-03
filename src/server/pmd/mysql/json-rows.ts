/**
 * `JSON_TABLE` row sources, replacing PostgreSQL's `jsonb_populate_recordset`
 * and `jsonb_to_recordset`.
 *
 * PMD's bulk loader sends a batch as one JSON array and expands it into rows
 * server-side:
 *
 *     INSERT INTO pmd.raw_record (run_id, source_id, …)
 *     SELECT run_id, source_id, … FROM jsonb_populate_recordset(NULL::pmd.raw_record, $1)
 *
 * The `NULL::pmd.raw_record` is the interesting part: it gave the row shape by
 * naming the *table*, so the query never restated the column types and could
 * not drift from the schema. MySQL's `JSON_TABLE` needs the types spelled out,
 * so this reads them back from `information_schema` to keep that property -
 * one query per table per process, cached. The alternative was transcribing
 * ~150 column types across ten call sites by hand, where a wrong width would
 * silently truncate a value rather than fail.
 *
 * The emitted source is aliased `r`, and because it is the only row source in
 * these statements the select lists can go on naming columns bare, exactly as
 * they did.
 *
 * A JSON column inside a batch row is a **plain** JavaScript value, never
 * `sql.json(value)`. The whole array is one JSON parameter, so a wrapper would
 * be serialised as the wrapper object and the column would receive
 * `{"value": …}` instead of the value. (That is what the original Postgres code
 * did too - it passed the array through `sql.json(rows)` and left the nested
 * objects plain.) `assertPlainRows` below refuses a wrapper rather than let it
 * reach the column, because the corrupted shape only shows up on read.
 *
 * Both builders return a `RowSource` rather than a fragment, because reading
 * the column types is asynchronous and a fragment is a Promise: returning one
 * from an `async` function lets `await` adopt it, which *executes* it. The
 * first version of this did exactly that, and the statement that reached the
 * server was the bare `JSON_TABLE(…)` with the SELECT around it dropped.
 */
import type { Queryable } from "../db";
import { JsonParam, RowSource } from "./sql";

/** table name (optionally `db.table`) -> column -> its MySQL type. */
const schemaCache = new Map<string, Map<string, string>>();

async function columnTypes(sql: Queryable, table: string): Promise<Map<string, string>> {
  const cached = schemaCache.get(table);
  if (cached) return cached;

  const [schema, name] = table.includes(".") ? table.split(".", 2) : [null, table];
  const rows = await sql<{ COLUMN_NAME: string; COLUMN_TYPE: string }[]>`
    SELECT COLUMN_NAME, COLUMN_TYPE
    FROM information_schema.columns
    WHERE TABLE_NAME = ${name}
      AND TABLE_SCHEMA = ${schema ?? sql`DATABASE()`}
      -- A generated column cannot be written, so it is never part of a batch.
      -- The test is on the two GENERATED kinds specifically: EXTRA also carries
      -- DEFAULT_GENERATED for a plain DEFAULT CURRENT_TIMESTAMP column, and
      -- those are ordinary insertable columns.
      AND EXTRA NOT LIKE '%VIRTUAL GENERATED%'
      AND EXTRA NOT LIKE '%STORED GENERATED%'`;
  if (rows.length === 0) throw new Error(`no columns found for ${table} - is the PMD schema applied?`);

  const map = new Map(rows.map((r) => [r.COLUMN_NAME, r.COLUMN_TYPE] as const));
  schemaCache.set(table, map);
  return map;
}

/** Only for tests: drops the cached schemas so a reset database is re-read. */
export function forgetColumnTypes(): void {
  schemaCache.clear();
}

/**
 * A `JSON_TABLE(…) AS r` row source over `rows`, shaped by `table`'s own
 * columns - the direct replacement for
 * `jsonb_populate_recordset(NULL::<table>, …)`.
 *
 * `columns` are the ones the statement goes on to select. Naming them rather
 * than expanding the whole table keeps the statement to what it needs, and a
 * name the table does not have is an error here rather than a confusing one
 * from the server.
 */
export async function jsonRows(
  sql: Queryable,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[],
): Promise<RowSource> {
  const types = await columnTypes(sql, table);
  const spec = columns.map((column) => {
    const type = types.get(column);
    if (!type) throw new Error(`${table} has no column ${column}`);
    return columnSpec(sql, column, type);
  });
  return build(sql, spec, rows);
}

/**
 * An inline row source whose columns are declared at the call site rather than
 * taken from a table - the replacement for `jsonb_to_recordset(…) AS r(name
 * text, …)`, which likewise declared them inline.
 */
export function jsonRowsTyped(
  sql: Queryable,
  columns: Record<string, string>,
  rows: readonly unknown[],
): RowSource {
  const spec = Object.entries(columns).map(([column, type]) => columnSpec(sql, column, type));
  return build(sql, spec, rows);
}

function build(sql: Queryable, spec: readonly unknown[], rows: readonly unknown[]): RowSource {
  assertPlainRows(rows);
  return sql`JSON_TABLE(${sql.json(rows)}, '$[*]' COLUMNS (${joinWith(sql, spec, ", ")})) AS r`.toRowSource();
}

/**
 * Refuses a `sql.json(...)` wrapper nested inside a batch row. See the note at
 * the top: the wrapper would be serialised along with everything else and the
 * column would get `{"value": …}`. Cheap - one shallow pass over the batch.
 */
function assertPlainRows(rows: readonly unknown[]): void {
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row)) {
      if (value instanceof JsonParam) {
        throw new Error(
          `${key} in a JSON_TABLE batch row is wrapped in sql.json(); pass the plain value — ` +
            "the whole batch is already one JSON parameter.",
        );
      }
    }
  }
}

/**
 * One `COLUMNS (...)` entry.
 *
 * The JSON path has to be *literal* text: MySQL reads it when it parses the
 * statement, so a placeholder there is a syntax error rather than a value. That
 * makes the column name part of the SQL, so it is checked against a strict
 * pattern first - everything PMD passes is either read from
 * information_schema or written in this repository, and a name that is neither
 * should fail here rather than be interpolated.
 */
function columnSpec(sql: Queryable, column: string, type: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`refusing to build a JSON_TABLE path for column name ${JSON.stringify(column)}`);
  }
  // The name is also quoted on the left, so a column that happens to be a
  // reserved word (product_image.rank) still resolves.
  return sql`${sql(column)} ${sql.unsafe(type)} PATH ${sql.unsafe(`'$.${column}'`)}`;
}

/** Splices fragments together with a separator, since the shim has no join. */
function joinWith(sql: Queryable, parts: readonly unknown[], separator: string) {
  return parts.reduce<unknown>((acc, part, i) => (i === 0 ? part : sql`${acc}${sql.unsafe(separator)}${part}`), sql``);
}
