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

/**
 * What a query resolves to: the rows, plus postgres.js's `count`.
 *
 * For a SELECT that is the number of rows; for a bare UPDATE or DELETE it is
 * the number of rows the statement affected, which is what PMD's merge path
 * reports as "sourcesMoved". mysql2 enables CLIENT_FOUND_ROWS, so affectedRows
 * counts *matched* rows rather than changed ones - which is what PostgreSQL's
 * UPDATE count was, since Postgres updates every matched row even when the new
 * values are identical.
 *
 * `insertId` is not part of postgres.js's result; it is added because MySQL's
 * insert-or-get-id idiom is read off it:
 *
 *     INSERT INTO pmd.brand (...) VALUES (...)
 *       ON DUPLICATE KEY UPDATE brand_id = LAST_INSERT_ID(brand_id)
 *
 * On an insert `insertId` is the new key; on a duplicate, `LAST_INSERT_ID(x)`
 * sets the session value to the *existing* key and returns it. That replaces
 * PostgreSQL's `ON CONFLICT (k) DO UPDATE SET k = EXCLUDED.k RETURNING id`,
 * which existed only to force the row back out, and it costs no extra
 * round trip. For a multi-row insert it is only the *first* row's key, so a
 * batch still has to read its keys back.
 */
export type RowList<T extends readonly unknown[]> = T & { count: number; insertId: number };

/** What `sql.json(v)` produces: a value to be sent as a JSON parameter. */
class JsonParam {
  constructor(readonly value: unknown) {}
}

/**
 * A MySQL identifier, backquoted. Dotted names are split, so "pmd.brand"
 * becomes `pmd`.`brand` and not the single identifier `pmd.brand`.
 */
function quoteIdent(name: string): string {
  if (name.includes("`")) throw new Error(`refusing to quote an identifier containing a backtick: ${name}`);
  return name
    .split(".")
    .map((part) => `\`${part}\``)
    .join(".");
}

/**
 * postgres.js's `sql(...)` helpers, which are not tagged templates:
 *
 *     sql(ids)                        -> (?, ?, ?)              after IN
 *     sql(["a", "b"])                 -> `a`, `b`                after SELECT / ( / ,
 *     sql("pmd.brand")                -> `pmd`.`brand`
 *     sql(rows, "a", "b")             -> (`a`, `b`) VALUES (?, ?), (?, ?)
 *
 * An array of strings is `("a","b")` in one position and `` `a`,`b` `` in the
 * other, and the call itself cannot tell which: only the SQL around it can.
 * postgres.js resolves that by looking at the text immediately before the
 * interpolation, so this does the same, and the decision is therefore deferred
 * until compile() knows that text.
 *
 * Anything that matches none of the forms throws, naming the context. Guessing
 * would emit silently wrong SQL, which is the one outcome worth avoiding here.
 */
class Builder {
  constructor(
    readonly first: string | readonly unknown[],
    readonly columns: readonly string[],
  ) {}

  build(preceding: string): Compiled {
    // A single name is an identifier in every position PMD uses.
    if (typeof this.first === "string") return { text: quoteIdent(this.first), params: [] };

    const tail = preceding.slice(-60);
    const rows = this.first;

    // `INSERT INTO t ${sql(rows, ...cols)}` — columns and values together.
    if (/\binsert\s+into\s+[`\w.]+\s*$/i.test(tail)) {
      const cols = this.columns.length ? this.columns : Object.keys((rows[0] ?? {}) as object);
      if (!cols.length) throw new Error("the insert helper was given no columns and no rows to infer them from");
      if (!rows.length) throw new Error("the insert helper was given no rows");
      const names = cols.map(quoteIdent).join(", ");
      const placeholders = rows.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
      const params: unknown[] = [];
      for (const row of rows) {
        for (const col of cols) {
          const value = (row as Record<string, unknown>)[col];
          params.push(value instanceof JsonParam ? JSON.stringify(value.value) : value);
        }
      }
      return { text: `(${names}) VALUES ${placeholders}`, params };
    }

    // `IN ${sql(values)}` / `VALUES ${sql(values)}` — a parenthesised value list.
    if (/\b(in|values)\s*$/i.test(tail)) {
      if (rows.length === 0) {
        // `IN ()` is a syntax error; NULL matches nothing, which is what an
        // empty list means and what postgres.js produces here.
        return { text: "(NULL)", params: [] };
      }
      return { text: `(${rows.map(() => "?").join(", ")})`, params: [...rows] };
    }

    // `SELECT ${sql(cols)}` / `(${sql(cols)})` — a bare identifier list.
    if (/(select|returning|set|[(,])\s*$/i.test(tail)) {
      if (!rows.every((c) => typeof c === "string")) {
        throw new Error(
          `sql(...) in an identifier position was given non-strings: ${JSON.stringify(rows).slice(0, 80)}`,
        );
      }
      return { text: (rows as readonly string[]).map(quoteIdent).join(", "), params: [] };
    }

    throw new Error(
      `sql(...) could not tell whether to emit identifiers or values here. ` +
        `The SQL before it was ${JSON.stringify(tail)}.`,
    );
  }
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
 *
 * The type parameter is the **array** type, not the row type - `sql<Foo[]>`
 * yields `Foo[]` - because that is postgres.js's convention and all 64
 * annotated call sites in PMD are written that way.
 *
 * It implements the whole `Promise` interface, not just `PromiseLike`, so a
 * fragment can be handed to anything typed `Promise<...>` the way a postgres.js
 * query could.
 */
class Fragment<T extends readonly unknown[] = Row[]> implements Promise<RowList<T>> {
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
  static raw<T extends readonly unknown[]>(
    text: string,
    params: readonly unknown[],
    executor: Executor | null,
  ): Fragment<T> {
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
      } else if (value instanceof Builder) {
        const built = value.build(parts.join(""));
        parts.push(built.text);
        params.push(...built.params);
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

  async execute(): Promise<RowList<T>> {
    if (!this.executor) throw new Error("this SQL fragment is not bound to a connection");
    const { text, params } = this.compile();
    const [result] = await this.executor.query(text, params);
    // A write returns mysql2's ResultSetHeader rather than rows; postgres.js
    // gave an empty array for those, and PMD's callers expect an array - but
    // the affected-row count has to survive, because `.count` is read off it.
    const rows = Array.isArray(result) ? result : [];
    const header = Array.isArray(result) ? null : (result as { affectedRows?: number; insertId?: number });
    const out = rows as unknown as RowList<T>;
    // Non-enumerable so that spreading or serialising a result is unaffected,
    // which is how postgres.js attaches `count` too.
    const hidden = (key: string, value: number) =>
      Object.defineProperty(out, key, { value, enumerable: false, configurable: true, writable: true });
    hidden("count", header ? (header.affectedRows ?? 0) : rows.length);
    hidden("insertId", header?.insertId ?? 0);
    return out;
  }

  readonly [Symbol.toStringTag] = "Fragment";

  then<R1 = RowList<T>, R2 = never>(
    onfulfilled?: ((value: RowList<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<RowList<T> | R> {
    return this.execute().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<RowList<T>> {
    return this.execute().finally(onfinally);
  }
}

export interface PmdSql {
  /** Tagged template: `sql`SELECT …``. `T` is the row *array* type. */
  <T extends readonly unknown[] = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Fragment<T>;
  /** Value list, identifier list, or the insert helper — see Builder. */
  (first: string | readonly unknown[], ...columns: string[]): Builder;
  /** Send a value as a JSON parameter. */
  json(value: unknown): JsonParam;
  /** Literal SQL, for text assembled elsewhere. */
  unsafe<T extends readonly unknown[] = Row[]>(text: string, params?: unknown[]): Fragment<T>;
  /** Run `fn` inside one transaction on one connection. */
  begin<T>(fn: (tx: PmdSql) => Promise<T>): Promise<T>;
  begin<T>(options: string, fn: (tx: PmdSql) => Promise<T>): Promise<T>;
  /**
   * Take one connection out of the pool and hold it until `release()`.
   *
   * PMD's own code does not use this; the review-bridge test does, to hold a
   * lock from outside the transaction under test and prove a second promotion
   * queues behind it. That is a real requirement - the test cannot be written
   * without a second connection - so the shim provides it.
   */
  reserve(): Promise<ReservedSql>;
  /** Close the pool. */
  end(): Promise<void>;
}

/** A connection held out of the pool by `sql.reserve()`. */
export interface ReservedSql extends PmdSql {
  release(): void;
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
  const sql = ((first: TemplateStringsArray | string | readonly unknown[], ...values: unknown[]) => {
    // A tagged template's first argument is the only one carrying `raw`.
    if (Array.isArray(first) && "raw" in (first as object)) {
      return new Fragment(first as unknown as readonly string[], values, executor);
    }
    return new Builder(first as string | readonly unknown[], values as string[]);
  }) as PmdSql;

  sql.json = (value: unknown) => new JsonParam(value);
  sql.unsafe = <T extends readonly unknown[]>(text: string, params: unknown[] = []) =>
    Fragment.raw<T>(text, params, executor);

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

  sql.reserve = async (): Promise<ReservedSql> => {
    if (!pool) throw new Error("cannot reserve a connection from inside a transaction");
    const connection = await pool.getConnection();
    const reserved = bind(connection as unknown as Executor, null) as ReservedSql;
    reserved.release = () => connection.release();
    return reserved;
  };

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

export type { Fragment, JsonParam, Builder };
