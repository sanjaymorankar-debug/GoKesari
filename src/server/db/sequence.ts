/**
 * The three Postgres sequences this app used, reproduced on MySQL.
 *
 * Postgres generated these values in the column default:
 *
 *   shops.registration_number  'BKS-' || lpad(nextval('shop_registration_seq'), 6, '0')
 *   products.code              'P'    || lpad(nextval('product_code_seq'),      5, '0')
 *   grievances.ticket_number   'GRV-' || lpad(nextval('grievance_ticket_seq'),  6, '0')
 *
 * MySQL has neither sequences nor an expression default that could call one, so
 * the value is produced here and passed in with the insert. The formats are
 * unchanged: existing identifiers stay valid and keep sorting the same way.
 */
import { sql } from "drizzle-orm";

import { type DbClient } from ".";
import { atomically } from "./returning";

/** Each counter's name, and how its number is rendered. */
const SEQUENCES = {
  shop_registration_seq: (n: number) => `BKS-${String(n).padStart(6, "0")}`,
  product_code_seq: (n: number) => `P${String(n).padStart(5, "0")}`,
  grievance_ticket_seq: (n: number) => `GRV-${String(n).padStart(6, "0")}`,
} as const;

export type SequenceName = keyof typeof SEQUENCES;

/**
 * Formats an allocated counter value the way its PostgreSQL default did.
 *
 * Exported because the product-master layer allocates `product_code_seq` too,
 * against this same `counters` table, and it talks to mysql2 directly rather
 * than through drizzle - so it cannot call `nextSequenceValue` below. Sharing
 * the formatter is what stops the two spellings of a product code drifting
 * apart.
 */
export function formatSequenceValue(name: SequenceName, n: number): string {
  return SEQUENCES[name](n);
}

/**
 * The next value of `name`, formatted as its Postgres default was.
 *
 * The increment is one statement:
 *
 *   INSERT INTO counters (name, value) VALUES (?, LAST_INSERT_ID(1))
 *   ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)
 *
 * which creates the counter on first use and otherwise bumps it, and in both
 * branches leaves the new number in `LAST_INSERT_ID()`. InnoDB holds a row
 * lock for the statement, so two concurrent callers are serialised and cannot
 * be handed the same number — no `SELECT ... FOR UPDATE` round trip needed.
 *
 * It does need the transaction, though: `LAST_INSERT_ID()` is per connection,
 * and the pool would otherwise be free to run the read on a different one, so
 * the two statements are pinned to one connection by `atomically`.
 */
export async function nextSequenceValue(
  exec: DbClient,
  name: SequenceName,
): Promise<string> {
  return atomically(exec, async (tx) => {
    await tx.execute(
      sql`INSERT INTO counters (name, value) VALUES (${name}, LAST_INSERT_ID(1))
          ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)`,
    );
    const result = await tx.execute(sql`SELECT LAST_INSERT_ID() AS n`);
    // mysql2 hands back [rows, fields]; the counter is bigint, which arrives as
    // a number here and as a string only past 2^53.
    const rows = (Array.isArray(result) ? result[0] : result) as unknown as {
      n: number | string;
    }[];
    const n = Number(rows[0]?.n);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`counter ${name} returned no value`);
    }
    return formatSequenceValue(name, n);
  });
}
