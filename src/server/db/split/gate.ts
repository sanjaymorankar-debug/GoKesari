/**
 * A seller row locked as a gate (docs/db-split-2026-10/CODE_SPLIT_PLAN.md §2):
 * the transaction locks it FOR UPDATE and then counts or checks OTHER seller
 * rows — a referral code's last slot is decided by counting the registrations
 * holding it. On the split layout postgres_fdw reads the seller side at
 * REPEATABLE READ, from one snapshot taken before the lock wait, so a
 * transaction that waited would count the rows as they were before the
 * holder's insert. Touching the locked row (an UPDATE that changes nothing)
 * makes the waiter's lock fail with 40001 once the holder commits, and
 * db.transaction runs it again with a fresh snapshot. On one database the
 * waiter's next statement already sees the holder's rows: nothing is written.
 */
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { getEnv } from "@/lib/env";
import type { DbClient } from "@/server/db";

/** Call right after locking the row (`.for("update")`), on every path that locks it as a gate. */
export async function touchSellerRow(client: DbClient, table: PgTable, id: string): Promise<void> {
  if (getEnv().DB_SPLIT_MODE !== "split") return;
  await client.execute(sql`update ${table} set id = id where id = ${id}`);
}
