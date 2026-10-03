import { drizzle } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2";

import { getEnv } from "@/lib/env";
import * as schema from "./schema";

/**
 * Single pooled connection reused across hot reloads. Next.js re-evaluates
 * modules on every edit in dev, so without this the pool leaks connections.
 */
const globalForDb = globalThis as unknown as {
  __sql?: Pool;
};

/**
 * Managed MySQL providers (PlanetScale, RDS, Aiven) require TLS. MySQL spells
 * the URL flag `ssl-mode=REQUIRED`; `sslmode` is accepted too so a URL carried
 * over from the Postgres deployment still enables TLS rather than silently
 * connecting in the clear.
 */
function resolveSsl(url: string): { minVersion: "TLSv1.2" } | undefined {
  try {
    const params = new URL(url).searchParams;
    const mode = (
      params.get("ssl-mode") ??
      params.get("sslmode") ??
      ""
    ).toLowerCase();
    if (!mode || mode === "disabled" || mode === "disable") return undefined;
    return { minVersion: "TLSv1.2" };
  } catch {
    return undefined;
  }
}

function createClient(): Pool {
  const env = getEnv();
  const url = env.DATABASE_URL;

  return createPool({
    uri: url,
    // Managed providers cap connections far below a self-hosted server, so the
    // ceiling is configurable rather than hard-coded.
    connectionLimit: env.DATABASE_POOL_MAX,
    idleTimeout: 20_000,
    connectTimeout: 30_000,
    enableKeepAlive: true,
    ssl: resolveSsl(url),
    // MySQL DATETIME carries no zone, so the driver has to be told how to read
    // one. "Z" makes mysql2 both write and parse DATETIME as UTC; the default
    // ("local") would shift every timestamp by the host's offset, which on a
    // machine in Asia/Kolkata is a silent 5h30m error in both directions.
    timezone: "Z",
    // Money is bigint in the schema. Without this, mysql2 hands back a JS
    // number for BIGINT and loses precision past 2^53 silently. With it, only
    // out-of-range values arrive as strings, and drizzle's bigint mode
    // "number" coerces them (mapFromDriverValue -> Number(value)).
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
}

/**
 * The driver's `timezone: "Z"` only governs how mysql2 converts between JS
 * `Date` and the wire format. It does not change the *server* session, so
 * `NOW()`, `CURRENT_TIMESTAMP` (the default on 125 columns) and
 * `UNIX_TIMESTAMP()` would still be evaluated in the server's own zone and
 * disagree with everything the driver writes. Pinning each pooled connection
 * to UTC makes the two agree.
 */
function pinSessionToUtc(pool: Pool): Pool {
  pool.on("connection", (connection) => {
    // group_concat_max_len: GROUP_CONCAT replaced Postgres's string_agg (see
    // services/risk.ts), and MySQL's 1024-byte default would TRUNCATE the
    // result silently rather than erroring — a risk summary that quietly loses
    // its last few orders. 16 MB is far above anything these queries build.
    connection.query(
      "SET time_zone = '+00:00', group_concat_max_len = 16777216",
      (err) => {
        if (err) console.error("could not initialise the session", err);
      },
    );
  });
  return pool;
}

const client = globalForDb.__sql ?? pinSessionToUtc(createClient());
if (getEnv().NODE_ENV !== "production") globalForDb.__sql = client;

export const db = drizzle(client, { schema, mode: "default" });
export { schema };
export type Database = typeof db;

/** Transaction handle type, for services that accept an ambient transaction. */
export type DbClient =
  | Database
  | Parameters<Parameters<Database["transaction"]>[0]>[0];
