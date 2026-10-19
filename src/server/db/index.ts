import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Single pooled connection reused across hot reloads. Next.js re-evaluates
 * modules on every edit in dev, so without this the pool leaks connections.
 */
const globalForDb = globalThis as unknown as {
  __sql?: ReturnType<typeof postgres>;
};

/**
 * Managed Postgres providers (Neon, Supabase, RDS) require TLS and advertise it
 * as `?sslmode=require` in the URL. postgres-js needs the flag passed
 * explicitly, so it is read from the URL rather than assumed.
 */
function resolveSsl(url: string): "require" | false {
  try {
    const sslmode = new URL(url).searchParams.get("sslmode");
    if (!sslmode || sslmode === "disable") return false;
    return "require";
  } catch {
    return false;
  }
}

function createClient() {
  const env = getEnv();
  const url = env.DATABASE_URL;

  return postgres(url, {
    // Managed providers cap connections far below a self-hosted server — Neon's
    // free tier allows well under 100 — so the ceiling is configurable rather
    // than hard-coded.
    max: env.DATABASE_POOL_MAX,
    idle_timeout: env.DATABASE_IDLE_TIMEOUT_SECONDS,
    connect_timeout: 30,
    ssl: resolveSsl(url),
    // Money is bigint in the schema; postgres-js would otherwise hand back
    // strings for int8. Parse to number — all values are well inside 2^53.
    types: {
      bigint: postgres.BigInt,
    },
  });
}

/**
 * DATABASE_PREPARED_STATEMENTS=on: Drizzle runs every query through
 * `unsafe()`, which postgres-js leaves unprepared unless told otherwise; ask
 * for prepared statements by default (a caller passing `prepare` still wins).
 */
function withPreparedStatements(sql: postgres.Sql): postgres.Sql {
  const unsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((query: string, args?: postgres.ParameterOrJSON<never>[], options?: postgres.UnsafeQueryOptions) =>
    unsafe(query, args, { prepare: true, ...options })) as typeof sql.unsafe;
  return sql;
}

const client =
  globalForDb.__sql ?? (getEnv().DATABASE_PREPARED_STATEMENTS === "on" ? withPreparedStatements(createClient()) : createClient());
if (getEnv().NODE_ENV !== "production") globalForDb.__sql = client;

export const db = drizzle(client, { schema });

/**
 * Seller / customer split (docs/db-split-2026-10/CODE_SPLIT_PLAN.md §2): the
 * seller tables are reached through postgres_fdw, which runs the seller side
 * of every transaction at REPEATABLE READ. Two requests changing the same
 * seller row at once (two checkouts on one product's stock) then end with
 * "could not serialize access" (40001) for the second instead of a wait, as
 * on one database. With DB_SPLIT_MODE=split a top-level transaction that hits
 * it (or a deadlock, 40P01) is run again from the start, a few times, after a
 * short random pause. On one database nothing changes.
 */
const RETRYABLE_TRANSACTION_ERRORS = new Set(["40001", "40P01"]);
const TRANSACTION_ATTEMPTS = 6;

/** "could not serialize access" — only on the split layout (the seller side runs at REPEATABLE READ). */
export function isSerializationFailure(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return String(e?.cause?.code ?? e?.code) === "40001";
}

export function isRetryableTransactionError(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return RETRYABLE_TRANSACTION_ERRORS.has(String(e?.cause?.code ?? e?.code));
}

if (getEnv().DB_SPLIT_MODE === "split") {
  const transaction = db.transaction.bind(db);
  db.transaction = (async (...args: Parameters<typeof transaction>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await transaction(...args);
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt >= TRANSACTION_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.floor(Math.random() * 40)));
      }
    }
  }) as typeof db.transaction;
}
export { schema };
export type Database = typeof db;

/** Transaction handle type, for services that accept an ambient transaction. */
export type DbClient =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];
