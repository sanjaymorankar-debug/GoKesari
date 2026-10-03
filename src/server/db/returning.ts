/**
 * MySQL has no `RETURNING`, so the 180 call sites that relied on it become
 * mutate-then-select. Doing that by hand at each site would scatter two
 * correctness requirements across 46 files, so they live here instead:
 *
 *  1. **It has to be atomic.** Between the mutation and the select, another
 *     writer can change or delete the row, so the pair has to run inside one
 *     transaction. Call sites already inside a transaction must NOT open a
 *     second one, so `atomically` opens one only when it was handed the root
 *     `db` — see its comment.
 *
 *  2. **The predicate usually stops matching.** `set({ status: "DONE" })
 *     .where(eq(t.status, "PENDING"))` matches nothing once it has run, so
 *     re-running the caller's `where` after the update would return zero rows.
 *     The primary keys are therefore read and locked (`FOR UPDATE`) first, and
 *     every statement after that is driven by those keys rather than by the
 *     original predicate. That also makes the update hit exactly the rows that
 *     were locked.
 *
 * Returned rows keep the order the keys were read in, which for an insert is
 * the order of `values` — matching what `RETURNING` gave callers before.
 *
 * NOT used for upserts. `ON DUPLICATE KEY UPDATE` reports `affectedRows = 2`
 * per row it updated rather than 1, which makes drizzle's `$returningId()`
 * walk off the end of its generated-id list. Upsert sites read the row back by
 * their own conflict target instead.
 */
import {
  and,
  eq,
  getTableColumns,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  getTableConfig,
  type MySqlColumn,
  type MySqlTable,
} from "drizzle-orm/mysql-core";

import { db, type DbClient } from ".";

/** `[jsProperty, column]` for each column of the table's primary key. */
type KeyColumns = [string, MySqlColumn][];

/**
 * Runs `fn` inside a transaction, reusing the caller's if there is one.
 *
 * The test is identity against the root `db`: anything else is already a
 * transaction handle. It cannot be a feature test, because drizzle's
 * transaction handle also exposes `.transaction()` (it opens a savepoint), so
 * there is nothing on the object itself that distinguishes the two.
 */
export function atomically<T>(
  exec: DbClient,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return exec === db ? db.transaction((tx) => fn(tx)) : fn(exec);
}

function keyColumns(table: MySqlTable): KeyColumns {
  const entries = Object.entries(getTableColumns(table)) as KeyColumns;
  const inline = entries.filter(([, c]) => c.primary);
  if (inline.length > 0) return inline;

  const composite = getTableConfig(table).primaryKeys[0];
  if (composite) {
    const names = new Set(composite.columns.map((c) => c.name));
    return entries.filter(([, c]) => names.has(c.name));
  }
  throw new Error(
    `${getTableConfig(table).name} has no primary key, so RETURNING cannot be emulated for it`,
  );
}

/**
 * MySQL's equivalent of Postgres `ON CONFLICT DO NOTHING`, for use as
 * `.onDuplicateKeyUpdate({ set: keepExisting(table) })`.
 *
 * Deliberately not `INSERT IGNORE` (drizzle's `.ignore()`), which is the usual
 * suggestion: `IGNORE` downgrades *every* error on the statement to a warning —
 * a foreign-key violation, a value too long for its column, a bad enum member —
 * so a row that should have failed loudly is silently dropped instead. On
 * `insert(wallets).values({ userId }).ignore()` a bad `userId` would leave the
 * user with no wallet and raise nothing.
 *
 * Assigning a key column to itself writes nothing, and `ON DUPLICATE KEY
 * UPDATE` fires on duplicate keys only, so every other error still throws.
 */
export function keepExisting<T extends MySqlTable>(
  table: T,
): Record<string, SQL> {
  const [prop, col] = keyColumns(table)[0]!;
  return { [prop]: sql`${col}` };
}

function keyPredicate(keys: KeyColumns, rows: Record<string, unknown>[]): SQL {
  if (keys.length === 1) {
    const [prop, col] = keys[0]!;
    return inArray(
      col,
      rows.map((r) => r[prop]),
    );
  }
  // Composite key: (a = ? AND b = ?) OR (a = ? AND b = ?) ...
  return or(...rows.map((r) => and(...keys.map(([p, c]) => eq(c, r[p])))))!;
}

const keyOf = (keys: KeyColumns, row: Record<string, unknown>) =>
  JSON.stringify(keys.map(([p]) => row[p]));

/** Re-reads full rows for `keyRows`, in the order those keys were given. */
async function rowsForKeys<T extends MySqlTable>(
  tx: DbClient,
  table: T,
  keys: KeyColumns,
  keyRows: Record<string, unknown>[],
): Promise<T["$inferSelect"][]> {
  if (keyRows.length === 0) return [];
  const found = (await tx
    .select()
    .from(table as MySqlTable)
    .where(keyPredicate(keys, keyRows))) as Record<string, unknown>[];
  const byKey = new Map(found.map((r) => [keyOf(keys, r), r]));
  return keyRows
    .map((r) => byKey.get(keyOf(keys, r)))
    .filter(
      (r): r is Record<string, unknown> => r !== undefined,
    ) as T["$inferSelect"][];
}

/** `insert(t).values(v).returning()` */
export async function insertReturning<T extends MySqlTable>(
  exec: DbClient,
  table: T,
  values: T["$inferInsert"] | T["$inferInsert"][],
): Promise<T["$inferSelect"][]> {
  const given = (Array.isArray(values) ? values : [values]) as Record<
    string,
    unknown
  >[];
  if (given.length === 0) return [];
  const keys = keyColumns(table);

  return atomically(exec, async (tx) => {
    // Where the caller supplied every key column, those values identify the
    // rows and no round trip is needed to learn them.
    if (given.every((row) => keys.every(([p]) => row[p] !== undefined))) {
      await tx.insert(table).values(given as T["$inferInsert"][]);
      return rowsForKeys(tx, table, keys, given);
    }
    // Otherwise the key is defaulted. `$returningId()` reports the values
    // drizzle generated client-side from the column's `$defaultFn`, which is
    // why the schema generates ids in the application (see schema.ts uuidPk).
    const generated = (await tx
      .insert(table)
      .values(given as T["$inferInsert"][])
      .$returningId()) as Record<string, unknown>[];
    return rowsForKeys(tx, table, keys, generated);
  });
}

/** MySQL `ER_DUP_ENTRY`. */
function isDuplicateKey(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { errno?: number }).errno === 1062
  );
}

/**
 * `insert(t).values(v).onConflictDoNothing().returning()`.
 *
 * Returns `[]` when the row was already there and nothing was inserted, which
 * is what Postgres did and what several callers branch on — a notification that
 * must fire once per alert, a ledger snapshot that must be posted once per
 * order. Always handing back the row would turn those into duplicates.
 *
 * `affectedRows` cannot be used to tell the two apart: mysql2 connects with
 * `CLIENT_FOUND_ROWS`, so a duplicate whose no-op update changed nothing still
 * reports 1, the same as a fresh insert (verified against MariaDB 10.11). The
 * insert is therefore guarded by a read, with the duplicate-key error caught
 * for the race where another writer inserts in between. A failed statement
 * does not poison a MySQL transaction, so catching it and carrying on is safe.
 */
export async function insertIfNewReturning<T extends MySqlTable>(
  exec: DbClient,
  table: T,
  values: T["$inferInsert"],
  /** A predicate on the conflict target: what "already there" means. */
  match: SQL,
): Promise<T["$inferSelect"][]> {
  return atomically(exec, async (tx) => {
    const existing = await tx
      .select()
      .from(table as MySqlTable)
      .where(match);
    if (existing.length > 0) return [];
    try {
      await tx.insert(table).values(values);
    } catch (e) {
      if (isDuplicateKey(e)) return [];
      throw e;
    }
    return (await tx
      .select()
      .from(table as MySqlTable)
      .where(match)) as T["$inferSelect"][];
  });
}

/** `insert(t).values(v).onConflictDoUpdate({ target, set }).returning()` */
export async function upsertReturning<T extends MySqlTable>(
  exec: DbClient,
  table: T,
  values: T["$inferInsert"],
  set: Record<string, unknown>,
  /**
   * A predicate on the conflict target that finds the row whichever branch
   * fired. The caller has to supply it: `$returningId()` cannot be used after
   * `ON DUPLICATE KEY UPDATE`, which reports `affectedRows = 2` for each row it
   * updated and so walks drizzle's generated-id list off its end, and the
   * conflict target is not recoverable from the statement.
   */
  match: SQL,
): Promise<T["$inferSelect"][]> {
  return atomically(exec, async (tx) => {
    await tx
      .insert(table)
      .values(values)
      .onDuplicateKeyUpdate({ set: set as never });
    return (await tx
      .select()
      .from(table as MySqlTable)
      .where(match)) as T["$inferSelect"][];
  });
}

/** `update(t).set(s).where(w).returning()` */
export async function updateReturning<T extends MySqlTable>(
  exec: DbClient,
  table: T,
  set: Record<string, unknown>,
  where?: SQL,
): Promise<T["$inferSelect"][]> {
  const keys = keyColumns(table);

  return atomically(exec, async (tx) => {
    const locked = (await tx
      .select(Object.fromEntries(keys))
      .from(table as MySqlTable)
      .where(where)
      .for("update")) as Record<string, unknown>[];
    if (locked.length === 0) return [];

    await tx
      .update(table)
      .set(set as never)
      .where(keyPredicate(keys, locked));
    return rowsForKeys(tx, table, keys, locked);
  });
}

/** `delete(t).where(w).returning()` */
export async function deleteReturning<T extends MySqlTable>(
  exec: DbClient,
  table: T,
  where?: SQL,
): Promise<T["$inferSelect"][]> {
  const keys = keyColumns(table);

  return atomically(exec, async (tx) => {
    // The whole row is captured up front: after the delete there is nothing
    // left to read it back from.
    const doomed = (await tx
      .select()
      .from(table as MySqlTable)
      .where(where)
      .for("update")) as Record<string, unknown>[];
    if (doomed.length === 0) return [];

    await tx.delete(table).where(keyPredicate(keys, doomed));
    return doomed as T["$inferSelect"][];
  });
}
