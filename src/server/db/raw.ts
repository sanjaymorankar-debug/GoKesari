/**
 * Unwrapping raw `execute()` results.
 *
 * postgres-js resolved a query to the rows themselves, so `await db.execute(q)`
 * was already an array of records. mysql2 resolves to mysql2's own
 * `[rows, fields]` pair, so the same expression yields a two-element array
 * whose first entry is the rows and whose second is column metadata.
 *
 * That difference does not show up as a type error at the call sites that cast
 * (`as unknown as Row[]`), and iterating the pair silently walks two items —
 * the row set, then the field list — instead of the rows. Every raw query goes
 * through `rows()` so the unwrapping happens in exactly one place.
 */
export function rows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // [rows, fields] — the rows are themselves an array.
  const first: unknown = result[0];
  return (Array.isArray(first) ? first : result) as T[];
}

/** The single row of a query that returns at most one, or undefined. */
export function row<T>(result: unknown): T | undefined {
  return rows<T>(result)[0];
}
