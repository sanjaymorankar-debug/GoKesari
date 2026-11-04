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
export function withPreparedStatements<T extends postgres.Sql | postgres.TransactionSql>(sql: T): T {
  const unsafe = sql.unsafe.bind(sql);
  sql.unsafe = ((query: string, args?: postgres.ParameterOrJSON<never>[], options?: postgres.UnsafeQueryOptions) =>
    unsafe(query, args, { prepare: true, ...options })) as typeof sql.unsafe;
  // A transaction (and each savepoint inside it) runs on a fresh scoped `sql`
  // from postgres-js, without the wrapper above: wrap that one too, or every
  // statement Drizzle sends inside db.transaction stays unprepared.
  type Callback = (tx: postgres.TransactionSql) => unknown;
  const wrapCallback = (args: unknown[]) =>
    args.map((a) => (typeof a === "function" ? (tx: postgres.TransactionSql) => (a as Callback)(withPreparedStatements(tx)) : a));
  const scoped = sql as unknown as { begin?: (...args: unknown[]) => unknown; savepoint?: (...args: unknown[]) => unknown };
  for (const key of ["begin", "savepoint"] as const) {
    const original = scoped[key];
    if (typeof original === "function") scoped[key] = (...args: unknown[]) => original.apply(sql, wrapCallback(args));
  }
  return sql;
}

const client =
  globalForDb.__sql ?? (getEnv().DATABASE_PREPARED_STATEMENTS === "on" ? withPreparedStatements(createClient()) : createClient());
if (getEnv().NODE_ENV !== "production") globalForDb.__sql = client;

export const db = drizzle(client, { schema });

/**
 * A serialization failure (40001) or deadlock (40P01): the database has already
 * aborted the transaction, so a catch inside it must rethrow rather than carry on.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return ["40001", "40P01"].includes(String(e?.cause?.code ?? e?.code));
}

export { schema };
export type Database = typeof db;

/** Transaction handle type, for services that accept an ambient transaction. */
export type DbClient =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];
