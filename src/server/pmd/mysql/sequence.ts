/**
 * The three PMD identifier sequences, on a counters table.
 *
 * `pmd.brand`, `pmd.manufacturer` and `pmd.product_master` do **not** have
 * AUTO_INCREMENT primary keys, and that is not an oversight. Each carries a
 * human-facing code generated from its own key - `GKS-MFR-000000123` and the
 * like - and MySQL refuses a generated column that reads an AUTO_INCREMENT
 * column (errno 3109, "Generated column cannot refer to auto-increment
 * column"). PostgreSQL had no such restriction, so these were plain sequences
 * there. Keeping the codes meant allocating the keys in the application, which
 * is what this does.
 *
 * The idiom is MySQL's own, and it is atomic in one statement:
 *
 *     INSERT INTO pmd.counters (name, value) VALUES (?, LAST_INSERT_ID(?))
 *       ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + ?)
 *
 * The row lock on the counter serialises concurrent allocators, and
 * `LAST_INSERT_ID(expr)` both stores and returns the new high-water mark, so
 * the allocated block is `[returned - count + 1, returned]`.
 *
 * It returns through the statement's own `insertId` rather than a following
 * `SELECT LAST_INSERT_ID()`. That matters: LAST_INSERT_ID is per-connection, and
 * a pool hands consecutive statements to whichever connection is free, so a
 * separate read could land on a different one and return someone else's value.
 * Reading it off the same round trip cannot.
 *
 * Verified against MySQL 8.0.46: a fresh counter allocating a block of n
 * returns n, and 40 concurrent allocations of 3 produced 120 distinct ids with
 * no gaps and no overlap.
 */
import { formatSequenceValue } from "@/server/db/sequence";
import type { Queryable } from "../db";

/** The sequences PMD allocates from. Named so a typo is a type error. */
export type PmdSequence = "brand_seq" | "manufacturer_seq" | "product_seq";

/**
 * Reserves `count` consecutive ids and returns them.
 *
 * Reserved, not "the next ones": a failed insert keeps the numbers, exactly as
 * a PostgreSQL sequence did. Gaps are expected and harmless - nothing in PMD
 * treats these as dense.
 */
export async function nextIds(sql: Queryable, sequence: PmdSequence, count: number): Promise<number[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`cannot allocate ${count} ids`);
  const result = await sql`
    INSERT INTO pmd.counters (name, value) VALUES (${sequence}, LAST_INSERT_ID(${count}))
    ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + ${count})`;
  const last = result.insertId;
  if (!last) throw new Error(`${sequence} allocated nothing - is pmd.counters present?`);
  const first = last - count + 1;
  return Array.from({ length: count }, (_, i) => first + i);
}

/** One id. */
export async function nextId(sql: Queryable, sequence: PmdSequence): Promise<number> {
  const [id] = await nextIds(sql, sequence, 1);
  return id!;
}

/**
 * The next application product code (`P00001`), allocated from the
 * *application's* counters table rather than PMD's.
 *
 * The catalogue bridge inserts into the application's `products`, whose `code`
 * was a PostgreSQL sequence default and is now allocated by the application. A
 * raw insert does not go through drizzle, so it has to allocate the number
 * here - from the same table and with the same formatter the application uses,
 * so the two can never hand out different spellings or the same number.
 *
 * `counters` is unqualified on purpose: PMD connects with the application
 * database as its default schema, so this is the application's counter, not
 * `pmd.counters`.
 */
export async function nextProductCode(sql: Queryable): Promise<string> {
  const result = await sql`
    INSERT INTO counters (name, value) VALUES ('product_code_seq', LAST_INSERT_ID(1))
    ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)`;
  const n = result.insertId;
  if (!n) throw new Error("product_code_seq allocated nothing - is the application schema present?");
  return formatSequenceValue("product_code_seq", n);
}
