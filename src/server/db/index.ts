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

const client = globalForDb.__sql ?? createClient();
if (getEnv().NODE_ENV !== "production") globalForDb.__sql = client;

export const db = drizzle(client, { schema });
export { schema };
export type Database = typeof db;

/** Transaction handle type, for services that accept an ambient transaction. */
export type DbClient =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];
