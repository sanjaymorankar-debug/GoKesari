/**
 * Named locks held for the life of a transaction, replacing
 * `pg_advisory_xact_lock(hashtextextended(name, 0))`.
 *
 * PMD takes these to serialise work on one brand - two loaders that both find
 * no brand "Amul" would otherwise both create it, the second under an "amul-2"
 * slug. MySQL has no advisory locks, so the lock is a row in
 * `pmd.advisory_lock` and the lock is InnoDB's row lock on it.
 *
 * `GET_LOCK()` exists and is closer in spelling, but not in behaviour: it is
 * scoped to the *session*, survives COMMIT and ROLLBACK, and has to be released
 * by hand - so an early return or a thrown error leaks it until the connection
 * is returned to the pool and reused. A row lock is released by the transaction
 * ending, however it ends, which is what `_xact_` meant.
 *
 * Two differences from the Postgres version are deliberate improvements:
 * the name is stored rather than hashed, so `SELECT * FROM pmd.advisory_lock`
 * says what is being held; and there is no 64-bit hash to collide.
 *
 * Locks are always taken in sorted order. Two transactions that each want
 * brands {A, B} would deadlock if one took A first and the other B.
 */
import type { Queryable } from "../db";

/**
 * Takes `names` for the rest of the current transaction, blocking until they
 * are free.
 *
 * Must be called inside a transaction - outside one, autocommit ends it
 * immediately and the lock is released before it is any use, which is silent
 * rather than loud, so this cannot verify it and the callers all sit inside
 * `sql.begin`.
 */
export async function lockNames(sql: Queryable, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const sorted = [...new Set(names)].sort();

  // The row has to exist before it can be locked. A name another transaction
  // is inserting right now blocks here instead, which is the same serialisation
  // by a different route.
  // The insert helper emits the column list as well as the values, so the
  // statement must not name the columns itself.
  await sql`
    INSERT INTO pmd.advisory_lock ${sql(sorted.map((name) => ({ name })) as never, "name" as never)}
    ON DUPLICATE KEY UPDATE name = name`;

  // ORDER BY inside the locking read is what keeps the acquisition order fixed.
  await sql`SELECT name FROM pmd.advisory_lock WHERE name IN ${sql(sorted)} ORDER BY name FOR UPDATE`;
}

/**
 * A PMD lock name. The `pmd:` prefix was in the hashed string before and is
 * kept, so the names read the same as the Postgres ones did.
 */
export function pmdLock(suffix: string): string {
  return `pmd:${suffix}`;
}

/** The per-brand lock the loaders take, spelled the same way in both. */
export function brandLockName(brandKey: string): string {
  return pmdLock(`b:${brandKey}`);
}
