/**
 * PostgreSQL access for the platform (postgres.js, plain SQL).
 *
 * The pipeline is set-based and batch-oriented - upserts, ON CONFLICT, trigram
 * retrieval - which is what SQL is for, so it talks to postgres.js directly rather
 * than through an ORM row-at-a-time. The application's Drizzle client is used only
 * by the app's own services.
 *
 * Type handling differs from a default postgres.js client on purpose:
 *   bigint  -> number   (ids and integer minor units are far inside 2^53; verified)
 *   numeric -> number   (scores and canonical quantities; money is bigint, never numeric)
 *   date    -> string   'YYYY-MM-DD', so a date never shifts with the server's timezone
 */
import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;
/** Either the pool or a transaction: what repository functions accept. */
export type Queryable = Sql | TransactionSql;

/** postgres.js widens tagged-template parameters to a union of primitives; JSON goes through sql.json. */
export type JsonValue = postgres.JSONValue;

function resolveSsl(url: string): "require" | false {
  try {
    const mode = new URL(url).searchParams.get("sslmode");
    return !mode || mode === "disable" ? false : "require";
  } catch {
    return false;
  }
}

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;

export function createSql(url: string, opts: { max?: number; applicationName?: string } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 30,
    ssl: resolveSsl(url),
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? "gokesari-pmd" },
    types: {
      bigint: {
        to: INT8,
        from: [INT8],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`bigint ${x} does not fit a JS number`);
          return n;
        },
      },
      numeric: {
        to: NUMERIC,
        from: [NUMERIC],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
      date: {
        to: DATE,
        from: [DATE],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)),
        parse: (x: string) => x,
      },
    },
  });
}

const globalForPmd = globalThis as unknown as { __pmdSql?: Sql };

/**
 * The application's own PMD connection (API routes, dashboard). Bound to
 * DATABASE_URL - the app's database - and reused across dev hot reloads.
 */
export function appSql(): Sql {
  if (!globalForPmd.__pmdSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForPmd.__pmdSql = createSql(url, { max: 5, applicationName: "gokesari-pmd-app" });
  }
  return globalForPmd.__pmdSql;
}
