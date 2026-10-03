/**
 * The two upsert idioms this port needs that MySQL spells differently enough
 * from PostgreSQL to be worth naming once rather than at 24 call sites.
 *
 * PMD's loaders lean on two things `ON CONFLICT` gave for free:
 *
 *   1. **the row back out**, via `DO UPDATE SET k = EXCLUDED.k RETURNING id` —
 *      an update that changes nothing, written only so `RETURNING` fires on a
 *      conflict. MySQL's `LAST_INSERT_ID(id)` idiom does that directly, so
 *      those sites read `result.insertId` and need no helper.
 *
 *   2. **whether the row was new**, via `DO NOTHING RETURNING id` (a row comes
 *      back only on an insert) or `RETURNING (xmax = 0)` (Postgres's system
 *      column, which has no MySQL counterpart at all). Both are `insertedNew`
 *      below, and both matter: one advances an image rank, the other counts
 *      newly-opened attribute conflicts.
 *
 * `affectedRows` cannot answer (2). Measured on MySQL 8.0.46, for
 * `INSERT … ON DUPLICATE KEY UPDATE`: a fresh insert gives 1, a duplicate that
 * changes a column gives 2, and **a duplicate that changes nothing also gives
 * 1** — indistinguishable from the insert. (mysql2 enables CLIENT_FOUND_ROWS,
 * which is what turns the documented 0 into 1.) So the count is unusable here
 * and the insert is attempted bare, letting the duplicate key raise.
 *
 * That is safe on MySQL in a way it would not have been on PostgreSQL, and the
 * difference is why these call sites can stay as simple as they are: a
 * duplicate-key error does **not** abort a MySQL transaction. Verified against
 * MySQL 8.0.46 — writes before and after a caught ER_DUP_ENTRY both commit.
 * PostgreSQL would have poisoned the transaction, forcing a savepoint around
 * every attempt, which is precisely why the original code reached for
 * `ON CONFLICT DO NOTHING` instead of a catch.
 */

/** MySQL's duplicate-key error. */
const ER_DUP_ENTRY = 1062;

/** drizzle and mysql2 both wrap errors, so the errno can be a `cause` down. */
function isDuplicateKey(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (typeof e === "object" && (e as { errno?: number }).errno === ER_DUP_ENTRY) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs an INSERT that carries no `ON DUPLICATE KEY UPDATE`, and reports whether
 * it inserted.
 *
 * `true` means the row is new; `false` means an equal row was already there.
 * Any other error propagates — which is the point of not using `INSERT IGNORE`,
 * since `IGNORE` would downgrade a foreign-key violation or a truncation to a
 * warning and report the same `false`.
 */
export async function insertedNew(statement: PromiseLike<unknown>): Promise<boolean> {
  try {
    await statement;
    return true;
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}
