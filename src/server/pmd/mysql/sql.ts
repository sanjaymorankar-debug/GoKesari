/**
 * A postgres.js-shaped `sql` tag over mysql2, for the PMD layer.
 *
 * PMD issues 232 queries as postgres.js tagged templates. mysql2 has no such
 * API, so the alternative was rewriting all 232 into `query(text, params)` —
 * a change with no behavioural benefit and 232 chances to get a parameter
 * wrong. This provides the small part of postgres.js's surface PMD actually
 * uses instead. The survey behind docs/PMD_MYSQL_PORT.md found no cursors, no
 * streaming, no LISTEN/NOTIFY and no `.reserve()`, which is what makes a shim
 * of this size sufficient.
 *
 * The one subtle requirement is **laziness**. postgres.js templates do not run
 * when they are written; they run when awaited. That is what lets PMD nest them:
 *
 *     sql`SELECT … WHERE 1=1 ${q ? sql`AND name LIKE ${q}` : sql``}`
 *
 * So a template here returns a Fragment, not a Promise. A Fragment compiles to
 * text and parameters, splices any Fragment interpolated into it, and executes
 * only when something awaits it.
 *
 * Type handling matches what db.ts pinned on postgres.js, so callers see the
 * same JavaScript values they saw on PostgreSQL:
 *   bigint  -> number   (ids and integer minor units are far inside 2^53)
 *   decimal -> number   (scores and canonical quantities; money is bigint)
 *   date    -> string   'YYYY-MM-DD', so a date never shifts with the timezone
 */
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";

export type Row = Record<string, unknown>;

/** What `sql.json(v)` produces: a value to be sent as a JSON parameter. */
class JsonParam {
  constructor(readonly value: unknown) {}
}

/** Anything that can run a compiled statement: the pool, or one connection. */
interface Executor {
  query(text: string, params: unknown[]): Promise<[unknown, unknown]>;
}

interface Compiled {
  text: string;
  params: unknown[];
}

/**
 * A lazily-compiled statement or fragment.
 *
 * `then` is what makes it awaitable; until something awaits it, it is just a
 * tree of strings and values that a bigger Fragment can absorb.
 */
class Fragment<T = Row> implements PromiseLike<T[]> {
  /** Parameters that belong to literal text rather than to an interpolation. */
  private readonly rawParams: readonly unknown[];

  constructor(
    private readonly strings: readonly string[],
    private readonly values: readonly unknown[],
    private readonly executor: Executor | null,
    rawParams: readonly unknown[] = [],
  ) {
    this.rawParams = rawParams;
  }

  /** A fragment with literal text and no interpolation — for sql.unsafe. */
  static raw<T>(text: string, params: readonly unknown[], executor: Executor | null): Fragment<T> {
    return new Fragment<T>([text], [], executor, params);
  }

  compile(): Compiled {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < this.strings.length; i += 1) {
      parts.push(this.strings[i]!);
      if (i >= this.values.length) continue;
      const value = this.values[i];
      if (value instanceof Fragment) {
        const inner = value.compile();
        parts.push(inner.text);
        params.push(...inner.params);
      } else if (value instanceof JsonParam) {
        parts.push("?");
        params.push(JSON.stringify(value.value));
      } else {
        parts.push("?");
        params.push(value);
      }
    }
    params.push(...this.rawParams);
    return { text: parts.join(""), params };
  }

  async execute(): Promise<T[]> {
    if (!this.executor) throw new Error("this SQL fragment is not bound to a connection");
    const { text, params } = this.compile();
    const [rows] = await this.executor.query(text, params);
    // A write returns mysql2's ResultSetHeader rather than rows; postgres.js
    // gave an empty array for those, and PMD's callers expect an array.
    return (Array.isArray(rows) ? rows : []) as T[];
  }

  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/** A list for `IN ${sql(values)}` — postgres.js emits the parenthesised list. */
function listFragment(values: readonly unknown[], executor: Executor | null): Fragment {
  if (values.length === 0) {
    // `IN ()` is a syntax error; NULL matches nothing, which is what an empty
    // list means and what postgres.js produces here.
    return new Fragment(["(NULL)"], [], executor);
  }
  const strings = ["("];
  for (let i = 1; i < values.length; i += 1) strings.push(", ");
  strings.push(")");
  return new Fragment(strings, [...values], executor);
}

export interface PmdSql {
  /** Tagged template: `sql`SELECT …`` */
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Fragment<T>;
  /** List expansion: `IN ${sql(ids)}` */
  (values: readonly unknown[]): Fragment;
  /** Send a value as a JSON parameter. */
  json(value: unknown): JsonParam;
  /** Literal SQL, for text assembled elsewhere. */
  unsafe<T = Row>(text: string, params?: unknown[]): Fragment<T>;
  /** Run `fn` inside one transaction on one connection. */
  begin<T>(fn: (tx: PmdSql) => Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (tx: PmdSql) => Promise<T>): Promise<T>;
  /** Close the pool. */
  end(): Promise<void>;
}

/** mysql2 field shape, for the type casts below. */
interface Field {
  type: string;
  length: number;
  string(): string | null;
  buffer(): Buffer | null;
}

function typeCast(field: Field, next: () => unknown): unknown {
  // DATE stays a 'YYYY-MM-DD' string, as db.ts made it on postgres.js, so a
  // date can never shift with the server's or the driver's timezone.
  if (field.type === "DATE") return field.string();
  // DECIMAL/NEWDECIMAL arrive as strings; PMD's scores and quantities are
  // numbers. (Money is bigint, never decimal — see the schema conventions.)
  if (field.type === "DECIMAL" || field.type === "NEWDECIMAL") {
    const raw = field.string();
    return raw === null ? null : Number(raw);
  }
  if (field.type === "LONGLONG") {
    const raw = field.string();
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw new Error(`bigint ${raw} does not fit a JS number`);
    return n;
  }
  // TINY(1) is boolean in this schema; mysql2 would give 0/1.
  if (field.type === "TINY" && field.length === 1) {
    const raw = field.string();
    return raw === null ? null : raw === "1";
  }
  return next();
}

function sslFor(url: string) {
  try {
    const params = new URL(url).searchParams;
    const mode = (params.get("ssl-mode") ?? params.get("sslmode") ?? "").toLowerCase();
    return !mode || mode === "disabled" || mode === "disable" ? undefined : { minVersion: "TLSv1.2" as const };
  } catch {
    return undefined;
  }
}

/** Builds the callable `sql` object around one executor. */
function bind(executor: Executor, pool: Pool | null): PmdSql {
  const sql = ((first: TemplateStringsArray | readonly unknown[], ...values: unknown[]) => {
    // A tagged template's first argument is the only one carrying `raw`.
    if (Array.isArray(first) && "raw" in (first as object)) {
      return new Fragment(first as unknown as readonly string[], values, executor);
    }
    return listFragment(first as readonly unknown[], executor);
  }) as PmdSql;

  sql.json = (value: unknown) => new JsonParam(value);
  sql.unsafe = <T>(text: string, params: unknown[] = []) => Fragment.raw<T>(text, params, executor);

  sql.begin = (async (
    a: string | ((tx: PmdSql) => Promise<unknown>),
    b?: (tx: PmdSql) => Promise<unknown>,
  ) => {
    if (!pool) {
      // Already inside a transaction: postgres.js would open a savepoint.
      // Nothing in PMD nests sql.begin, so reusing the connection is enough
      // and keeps the statements on it.
      const fn = (typeof a === "function" ? a : b)!;
      return fn(bind(executor, null));
    }
    const options = typeof a === "string" ? a : "";
    const fn = (typeof a === "function" ? a : b)!;
    const connection: PoolConnection = await pool.getConnection();
    try {
      // postgres.js takes `sql.begin("read only", fn)`; MySQL spells the same
      // thing START TRANSACTION READ ONLY.
      await connection.query(
        /read\s*only/i.test(options) ? "START TRANSACTION READ ONLY" : "START TRANSACTION",
        [],
      );
      try {
        const out = await fn(bind(connection as unknown as Executor, null));
        await connection.query("COMMIT", []);
        return out;
      } catch (error) {
        await connection.query("ROLLBACK", []).catch(() => {});
        throw error;
      }
    } finally {
      connection.release();
    }
  }) as PmdSql["begin"];

  sql.end = async () => {
    if (pool) await pool.end();
  };
  return sql;
}

export function createSql(url: string, opts: { max?: number; applicationName?: string } = {}): PmdSql {
  const pool = createPool({
    uri: url,
    connectionLimit: opts.max ?? 5,
    idleTimeout: 20_000,
    connectTimeout: 30_000,
    enableKeepAlive: true,
    ssl: sslFor(url),
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: false,
    typeCast: typeCast as never,
  });
  // Same session settings as the application pool: the driver's own timezone
  // option does not reach the server, so NOW() and CURRENT_TIMESTAMP(3) would
  // otherwise be evaluated in the server's zone.
  // The promise pool forwards the *callback-style* connection on this event, not
  // the promise wrapper, so this has to use the callback form.
  pool.on("connection", (connection) => {
    (connection as unknown as {
      query: (text: string, cb: (err: unknown) => void) => void;
    }).query("SET time_zone = '+00:00', group_concat_max_len = 16777216", (err) => {
      if (err) console.error("could not initialise the PMD session", err);
    });
  });
  return bind(pool as unknown as Executor, pool);
}

export type { Fragment, JsonParam };
