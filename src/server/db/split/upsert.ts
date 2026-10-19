/**
 * INSERT … ON CONFLICT (keys) DO UPDATE, written so it also works on a seller
 * table that is a postgres_fdw foreign table in the core database
 * (docs/db-split-2026-10/CODE_SPLIT_PLAN.md §2): postgres_fdw cannot see the
 * remote unique index, so it refuses a conflict target and DO UPDATE.
 *
 * Update the row by its key; when there is none, insert it inside a savepoint;
 * if another request inserted the same key in between (unique violation),
 * update that row instead. Same result as the upsert, on one database or two.
 */
import { and, eq, getTableColumns } from "drizzle-orm";
import type { PgColumn, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { DbClient } from "@/server/db";

export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.cause?.code ?? e?.code) === "23505";
}

export async function upsertRow<T extends PgTable>(
  client: DbClient,
  table: T,
  options: {
    /** The unique key's columns; their values are taken from `values`. */
    keys: PgColumn[];
    /** The row to insert when none exists. */
    values: T["$inferInsert"];
    /** What to change when the row exists (may use sql`${col} + 1`). */
    set: PgUpdateSetSource<T>;
  },
): Promise<T["$inferSelect"]> {
  const columns = Object.entries(getTableColumns(table)) as [string, PgColumn][];
  const where = and(
    ...options.keys.map((key) => {
      const property = columns.find(([, column]) => column === key)?.[0];
      if (!property) throw new Error(`upsertRow: ${key.name} is not a column of this table`);
      return eq(key, (options.values as Record<string, unknown>)[property]);
    }),
  );
  // Drizzle's generic table types don't line up with a generic T here; the calls are checked by the overload above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  for (let attempt = 0; attempt < 3; attempt++) {
    const updated = await c.update(table).set(options.set).where(where).returning();
    if (updated.length) return updated[0];
    try {
      // A savepoint inside a transaction (a transaction of its own otherwise), so a lost race does not abort the caller's work.
      return await c.transaction(async (sp: DbClient) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [row] = await (sp as any).insert(table).values(options.values).returning();
        return row;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error("upsertRow: the row kept changing under concurrent writes; try again.");
}
