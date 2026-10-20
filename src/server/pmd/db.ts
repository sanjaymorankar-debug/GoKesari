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

/**
 * Settings only libpq understands. postgres.js sends unknown URL settings to the server as
 * session settings, which Postgres refuses ("unrecognized configuration parameter"), and
 * Neon's copy-paste URLs carry channel_binding=require: a SELLER_DATABASE_URL pasted that
 * way would fail every product-master query once the site reads the seller database
 * directly. Same list as src/server/db/split/tools.ts.
 */
const LIBPQ_ONLY_PARAMS = ["channel_binding", "gssencmode", "sslcert", "sslkey", "sslpassword", "sslcrl", "krbsrvname"];

function openableUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    for (const key of LIBPQ_ONLY_PARAMS) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

const INT8 = 20;
const NUMERIC = 1700;
const DATE = 1082;

export function createSql(url: string, opts: { max?: number; applicationName?: string } = {}): Sql {
  return postgres(openableUrl(url), {
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

const globalForPmd = globalThis as unknown as { __pmdSql?: Sql; __pmdSellerSql?: Sql; __pmdLayout?: { split: boolean; at: number } };

/** How long the site trusts its last look at the layout: a switch, or a switch back, reaches every server within this. */
export const LAYOUT_CHECK_MS = 30_000;

/** The postgres_fdw server the switch creates in the core (scripts/split-migrate.mjs SELLER_SERVER). */
const SELLER_SERVER = "gk_seller";

function pool(key: "__pmdSql" | "__pmdSellerSql", url: string | undefined): Sql {
  if (!globalForPmd[key]) {
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForPmd[key] = createSql(url, { max: 5, applicationName: "gokesari-pmd-app" });
  }
  return globalForPmd[key]!;
}

/** Host (Neon's pooled and direct hosts are the same database) and database name of a connection string. */
export function databaseOf(url: string): string {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.pathname.replace(/^\//, ""))} on ${u.hostname.replace(/-pooler(?=\.)/, "")}`;
  } catch {
    return "(not a database URL)";
  }
}

/**
 * Whether the site's database has been switched to the split layout, and
 * SELLER_DATABASE_URL is the database the switch filled (looked up at most
 * every LAYOUT_CHECK_MS). A different seller database is not used: the site
 * then stays on its own connection (which reaches the seller tables through
 * the switch's link) and says so in the log.
 */
async function switched(core: Sql, sellerUrl: string, cached: boolean): Promise<boolean> {
  const known = globalForPmd.__pmdLayout;
  if (cached && known && Date.now() - known.at < LAYOUT_CHECK_MS) return known.split;
  const [row] = await core<{ host: string | null; dbname: string | null }[]>`
    select (select substr(o, 6) from unnest(s.srvoptions) o where o like 'host=%') as host,
           (select substr(o, 8) from unnest(s.srvoptions) o where o like 'dbname=%') as dbname
    from pg_foreign_server s
    where s.srvname = ${SELLER_SERVER} and exists (select 1 from pg_foreign_table t where t.ftserver = s.oid)`;
  let split = Boolean(row);
  if (row && `${row.dbname} on ${row.host}` !== databaseOf(sellerUrl)) {
    console.error(
      `[pmd] SELLER_DATABASE_URL is ${databaseOf(sellerUrl)}, but this site's seller tables are in ${row.dbname} on ${row.host}. ` +
        "Not using it; set SELLER_DATABASE_URL to the seller database the switch filled.",
    );
    split = false;
  }
  if (cached) globalForPmd.__pmdLayout = { split, at: Date.now() };
  return split;
}

/**
 * The application's own PMD connection (API routes, dashboard), reused across
 * dev hot reloads.
 *
 * The product master lives in the seller database (docs/db-split-2026-10).
 * Once the site's database has been switched to the split layout and
 * DB_SPLIT_MODE=split, it is reached directly there, so its set-based SQL
 * (ON CONFLICT upserts, trigram search) runs natively; the few core tables it
 * touches (audit_logs, users) are foreign tables in the seller database.
 * Otherwise it is the site's one database (DATABASE_URL), as before. The site
 * looks at its database for this, so the two settings can be made on the host
 * before the switch, and nothing writes to the seller database while it is not
 * the live one.
 */
export async function appSql(env: NodeJS.ProcessEnv = process.env): Promise<Sql> {
  const core = pool("__pmdSql", env.DATABASE_URL);
  return (await goesToSellerDatabase(core, env)) ? pool("__pmdSellerSql", env.SELLER_DATABASE_URL) : core;
}

/** Whether the product master goes to SELLER_DATABASE_URL directly (see appSql). */
export async function goesToSellerDatabase(core: Sql, env: Record<string, string | undefined> = process.env, options: { cached?: boolean } = {}): Promise<boolean> {
  if (env.DB_SPLIT_MODE !== "split" || !env.SELLER_DATABASE_URL) return false;
  return switched(core, env.SELLER_DATABASE_URL, options.cached ?? true);
}
