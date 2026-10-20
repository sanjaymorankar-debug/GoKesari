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
 * of a transaction at REPEATABLE READ — one snapshot for the whole
 * transaction. Two transactions changing the same seller row then end in
 * "could not serialize access" (40001) instead of a wait, so with
 * DB_SPLIT_MODE=split a top-level transaction is run again from the start on
 * 40001 — and on a deadlock (40P01) — a few times, after a short random pause.
 *
 * The core side stays at READ COMMITTED, as on one database. It must never
 * fail at COMMIT: postgres_fdw commits the seller side first, so a core
 * transaction that failed then would leave its seller writes committed and
 * its core writes undone, and the re-run would apply the seller writes twice
 * (it ran at SERIALIZABLE until 20 Oct, whose check runs at COMMIT; seen in
 * CI as a legal document rejected without its audit row or notice). Every
 * 40001 now comes from a statement, before anything commits.
 *
 * A seller row locked only as a gate — the transaction then counts other
 * seller rows, as a referral code's last slot does — is touched with an
 * UPDATE right after the lock (touchSellerRow), so a transaction that waited
 * for it gets 40001 and re-runs with a fresh snapshot instead of counting the
 * rows as they were before the wait. On one database nothing changes.
 */
const RETRYABLE_TRANSACTION_ERRORS = new Set(["40001", "40P01"]);
const TRANSACTION_ATTEMPTS = 8;

/** "could not serialize access" — only on the split layout (its seller side runs at REPEATABLE READ). */
export function isSerializationFailure(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return String(e?.cause?.code ?? e?.code) === "40001";
}

export function isRetryableTransactionError(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return RETRYABLE_TRANSACTION_ERRORS.has(String(e?.cause?.code ?? e?.code));
}

/** The transaction as drizzle runs it: once, READ COMMITTED unless the caller says otherwise. */
const runOnce = db.transaction.bind(db);

/**
 * A top-level transaction that is never run twice, for work that calls an
 * outside service before it commits (the payment gateway): a re-run would call
 * it again. READ COMMITTED, as on one database, so the split layout's
 * serialization failures (and the re-run they trigger) do not arise; a
 * deadlock fails it like any other error. Prefer doing the outside call after
 * the commit; use this only where it has to happen under the transaction's lock.
 */
export const transactionOnce: typeof db.transaction = (run, config) => runOnce(run, { isolationLevel: "read committed", ...config });

if (getEnv().DB_SPLIT_MODE === "split") {
  const transaction = runOnce;
  db.transaction = (async (...[run, config]: Parameters<typeof transaction>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await transaction(run, { isolationLevel: "read committed", ...config });
      } catch (error) {
        if (!isRetryableTransactionError(error) || attempt >= TRANSACTION_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 50)));
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
