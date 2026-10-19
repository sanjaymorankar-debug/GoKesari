/**
 * Seller / customer database split — the migration tooling (Task 1,
 * docs/db-split-2026-10/README.md). Used by scripts/db-split/run.ts and the
 * integration test; not imported by the running site.
 *
 * Works on plain postgres.js connections so it can point at any three
 * databases: the SOURCE (today's single database, never modified), and the
 * two TARGETS (gokesari_seller, gokesari_customer).
 *
 *   prepareTarget   builds the target's schema with the same migrations the
 *                   site uses, then drops the tables the other database owns
 *                   (DROP … CASCADE also drops the foreign keys that pointed
 *                   at them — those relationships become service-layer checks)
 *   copyTables      streams every owned table with COPY, in one transaction
 *                   per table, foreign keys and triggers held off while it
 *                   loads, then restored and validated; sequences carried over
 *   fingerprint     row count + an order-independent checksum of every row
 *   verifyCopy      fingerprints source vs target, table by table
 *   crossDbReferences / checkCrossReferences
 *                   every foreign key that now spans the two databases, and
 *                   how many child rows point at a parent that is missing
 */
import { pipeline } from "node:stream/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { NOT_SPLIT_TABLES, physicalDatabase, SCHEMA_OWNERSHIP, tablesOwnedBy } from "./ownership";

export type Sql = postgres.Sql;
export type Side = "seller" | "customer";

/**
 * libpq-only URL settings. postgres.js would send them to the server as
 * session settings, which Postgres refuses ("unrecognized configuration
 * parameter") — Neon's copy-paste URLs carry channel_binding=require.
 */
const LIBPQ_ONLY_PARAMS = ["channel_binding", "gssencmode", "sslcert", "sslkey", "sslpassword", "sslcrl", "krbsrvname"];

export function connect(url: string, max = 2): Sql {
  let ssl: false | "require" = false;
  let clean = url;
  try {
    const u = new URL(url);
    const mode = u.searchParams.get("sslmode");
    ssl = !mode || mode === "disable" ? false : "require";
    for (const key of LIBPQ_ONLY_PARAMS) u.searchParams.delete(key);
    clean = u.toString();
  } catch {
    ssl = false;
  }
  return postgres(clean, { max, ssl, onnotice: () => undefined, types: { bigint: postgres.BigInt } });
}

/**
 * Names the roles that point at the same database, or null when all differ.
 * Compares host and database name, not the raw URL: Neon's pooled host
 * ("ep-x-pooler.…") and direct host ("ep-x.…") reach the same database.
 */
export function sameDatabaseClash(urls: Record<string, string>): string | null {
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const [role, url] of Object.entries(urls)) {
    let key = url;
    try {
      const u = new URL(url);
      key = `${u.hostname.replace("-pooler.", ".")}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
    } catch {
      // not a URL: compare the text as given
    }
    const other = seen.get(key);
    if (other) clashes.push(`${other} and ${role} are both ${describeUrl(url)}`);
    else seen.set(key, role);
  }
  return clashes.length ? clashes.join("; ") : null;
}

/** host/db for logs — never the password. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${decodeURIComponent(u.pathname.replace(/^\//, ""))} on ${u.hostname}`;
  } catch {
    return "(unparseable URL)";
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** A table name, schema-qualified when it is not in public ("pmd.product_master"). */
const qident = (name: string) => (name.includes(".") ? name.split(".").map(ident).join(".") : ident(name));
/** The schemas the split handles: public plus the whole-schema owners (pmd). */
const SPLIT_SCHEMAS = ["public", ...Object.keys(SCHEMA_OWNERSHIP)];

/* ------------------------------------------------------------ catalogue */

/**
 * Every table the split moves: public tables by name, tables of the owned
 * schemas as "schema.table". Partitions are left out — their rows are read
 * and written through the partitioned parent. Tables that are not GoKesari
 * data (NOT_SPLIT_TABLES, e.g. Neon's sample table) are left in the source.
 */
export async function publicTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any(${SPLIT_SCHEMAS}) and c.relkind in ('r', 'p') and not c.relispartition
    order by 1, 2`;
  return rows.map((r) => (r.schema === "public" ? r.name : `${r.schema}.${r.name}`)).filter((t) => !NOT_SPLIT_TABLES.includes(t));
}

/** The tables each database gets, from what the source actually has. */
export function splitTables(sourceTables: string[]): Record<Side, string[]> & { unowned: string[] } {
  return {
    seller: sourceTables.filter((t) => physicalDatabase(t) === "seller"),
    customer: sourceTables.filter((t) => physicalDatabase(t) === "customer"),
    unowned: sourceTables.filter((t) => physicalDatabase(t) === null),
  };
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  definition: string;
}

export async function listForeignKeys(sql: Sql, tables?: string[]): Promise<ForeignKey[]> {
  const rows = await sql<{ name: string; table: string; columns: string[]; ref_table: string; ref_columns: string[]; definition: string }[]>`
    select c.conname as name,
           c.conrelid::regclass::text as table,
           array(select a.attname from unnest(c.conkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.i)::text[] as columns,
           c.confrelid::regclass::text as ref_table,
           array(select a.attname from unnest(c.confkey) with ordinality k(n, i) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.i)::text[] as ref_columns,
           pg_get_constraintdef(c.oid) as definition
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = any(${SPLIT_SCHEMAS})
      and not exists (select 1 from pg_class p where p.oid = c.conrelid and p.relispartition)
    order by 2, 1`;
  const strip = (t: string) => t.replace(/^public\./, "").replace(/^"|"$/g, "");
  return rows
    .map((r) => ({ name: r.name, table: strip(r.table), columns: r.columns, refTable: strip(r.ref_table), refColumns: r.ref_columns, definition: r.definition }))
    .filter((fk) => !tables || tables.includes(fk.table));
}

/** Foreign keys whose two ends land in different databases after the split. */
export function crossDbReferences(fks: ForeignKey[]): (ForeignKey & { from: Side; to: Side })[] {
  return fks
    .map((fk) => ({ ...fk, from: physicalDatabase(fk.table) as Side, to: physicalDatabase(fk.refTable) as Side }))
    .filter((fk) => fk.from && fk.to && fk.from !== fk.to);
}

export async function copyableColumns(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select a.attname as name from pg_attribute a
    where a.attrelid = ${table.includes(".") ? qident(table) : `public.${ident(table)}`}::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    order by a.attnum`;
  return rows.map((r) => r.name);
}

/* ------------------------------------------------------------ prepare */

export interface PrepareResult {
  side: Side;
  migrationsApplied: boolean;
  droppedTables: string[];
  keptTables: string[];
}

/**
 * Builds the target's schema. Refuses a target that already holds data in
 * an owned table unless `replace` is set (then the copy truncates it).
 */
export async function prepareTarget(target: Sql, side: Side, options: { migrationsFolder?: string; replace?: boolean } = {}): Promise<PrepareResult> {
  const owned = new Set([...tablesOwnedBy(side), ...(await publicTables(target)).filter((t) => t.includes(".") && physicalDatabase(t) === side)]);
  const existing = await publicTables(target);
  if (existing.length > 0 && !options.replace) {
    for (const table of existing.filter((t) => owned.has(t))) {
      const [{ n }] = await target.unsafe<{ n: number }[]>(`select count(*)::int as n from (select 1 from ${qident(table)} limit 1) x`);
      if (n > 0 && !["platform_settings", "roles", "permissions", "role_permissions", "status_transition_rules", "referral_settings"].includes(table)) {
        throw new Error(`The ${side} database already has data in "${table}". Re-run with --replace to overwrite it.`);
      }
    }
  }
  // The migration lock is a session lock: take and release it on one pinned connection, not
  // on whichever pooled connection comes next (that left it held, and a second prepare waited forever).
  const lock = await target.reserve();
  try {
    await lock`select pg_advisory_lock(hashtext('gokesari-migrations'))`;
    try {
      await migrate(drizzle(target), { migrationsFolder: options.migrationsFolder ?? "./drizzle" });
    } finally {
      await lock`select pg_advisory_unlock(hashtext('gokesari-migrations'))`;
    }
  } finally {
    lock.release();
  }
  const tables = await publicTables(target);
  const drop = tables.filter((t) => physicalDatabase(t) !== side);
  for (const [schema, owner] of Object.entries(SCHEMA_OWNERSHIP)) {
    if ((owner === "seller" ? "seller" : "customer") !== side) await target.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }
  for (const table of drop.filter((t) => !t.includes("."))) await target.unsafe(`drop table if exists ${ident(table)} cascade`);
  return { side, migrationsApplied: true, droppedTables: drop, keptTables: tables.filter((t) => !drop.includes(t)) };
}

/* ------------------------------------------------------------ copy */

export interface CopyResult {
  table: string;
  rows: number;
  ms: number;
}

/**
 * Copies the tables from source to target. Foreign keys among the copied
 * tables are dropped for the load and re-created (and so re-validated)
 * afterwards; user triggers are disabled during the load so no trigger
 * rewrites a copied row.
 */
export interface CopyOptions {
  /**
   * Opens a fresh one-connection client on the source for each table's COPY
   * read; it is closed straight after. postgres.js 3.4 can leave a connection's
   * socket paused when a COPY ... TO STDOUT ends while its stream buffer is
   * full (the last CopyData and CopyDone arrive in one network chunk), and the
   * next query on that pooled connection then never gets its answer — seen on
   * Neon over TLS. A throwaway reader keeps the pool clean. Without it the
   * pooled `source` is used (fine on a local socket, as in the tests).
   */
  openReader?: () => Sql;
  /** Fail the table, not hang, when one copy takes longer than this. */
  tableTimeoutMs?: number;
}

export async function copyTables(
  source: Sql,
  target: Sql,
  tables: string[],
  log: (line: string) => void = () => undefined,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const targetTables = new Set(await publicTables(target));
  const missing = tables.filter((t) => !targetTables.has(t));
  if (missing.length) throw new Error(`Target is missing tables: ${missing.join(", ")}. Run prepare first.`);

  const fks = await listForeignKeys(target);
  const affected = fks.filter((fk) => tables.includes(fk.table) || tables.includes(fk.refTable));
  for (const fk of affected) await target.unsafe(`alter table ${qident(fk.table)} drop constraint if exists ${ident(fk.name)}`);

  const results: CopyResult[] = [];
  let stalled = false;
  try {
    for (const table of tables) {
      const started = Date.now();
      const columns = await copyableColumns(source, table);
      const list = columns.map(ident).join(", ");
      const reader = options.openReader ? options.openReader() : source;
      try {
        await withTimeout(
          target.begin(async (tx) => {
            await tx.unsafe(`alter table ${qident(table)} disable trigger user`);
            await tx.unsafe(`truncate table ${qident(table)}`);
            const readable = await reader.unsafe(`copy (select ${list} from ${qident(table)}) to stdout`).readable();
            const writable = await tx.unsafe(`copy ${qident(table)} (${list}) from stdin`).writable();
            await pipeline(readable, writable);
            await tx.unsafe(`alter table ${qident(table)} enable trigger user`);
          }),
          options.tableTimeoutMs,
          `copying ${table}`,
        ).catch((error) => {
          if (error instanceof CopyTimeoutError) stalled = true;
          throw error;
        });
      } finally {
        if (reader !== source) await reader.end({ timeout: 0 });
      }
      const [{ n }] = await target.unsafe<{ n: number }[]>(`select count(*)::int as n from ${qident(table)}`);
      results.push({ table, rows: n, ms: Date.now() - started });
      log(`copied ${table}: ${n} rows in ${Date.now() - started} ms`);
    }
  } finally {
    // Re-create every foreign key we removed; an orphan inside one database fails loudly here.
    // After a stalled copy the stuck transaction still locks its table, so this would hang too:
    // skip it — a stalled run is re-run with --replace, which rebuilds the target's schema.
    if (!stalled) for (const fk of affected) await target.unsafe(`alter table ${qident(fk.table)} add constraint ${ident(fk.name)} ${fk.definition}`);
  }
  await copySequences(source, target);
  return results;
}

class CopyTimeoutError extends Error {}

async function withTimeout<T>(work: Promise<T>, ms: number | undefined, what: string): Promise<T> {
  if (!ms) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CopyTimeoutError(`${what} took longer than ${Math.round(ms / 1000)} s — stopped instead of waiting`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Carries every sequence's position over (serials, identities and counters such as shop numbers). */
export async function copySequences(source: Sql, target: Sql): Promise<number> {
  const list = (sql: Sql) =>
    sql<{ name: string }[]>`
      select case when n.nspname = 'public' then c.relname else n.nspname || '.' || c.relname end as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname = any(${SPLIT_SCHEMAS})`;
  const targetSeqs = new Set((await list(target)).map((r) => r.name));
  let n = 0;
  for (const { name } of await list(source)) {
    if (!targetSeqs.has(name)) continue;
    const [state] = await source.unsafe<{ last_value: number; is_called: boolean }[]>(`select last_value, is_called from ${qident(name)}`);
    await target.unsafe(`select setval('${qident(name).replace(/'/g, "''")}', ${Number(state.last_value)}, ${state.is_called})`);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------ verify */

export interface Fingerprint {
  rows: number;
  checksum: string;
}

/**
 * Row count and an order-independent checksum: the sum over rows of the first
 * 60 bits of md5(row as text), with the columns named in a fixed order — so
 * the same rows give the same value in any database, whatever the physical order.
 */
export async function fingerprint(sql: Sql, table: string, columns?: string[]): Promise<Fingerprint> {
  const cols = columns ?? (await copyableColumns(sql, table));
  const row = `row(${cols.map((c) => `t.${ident(c)}`).join(", ")})::text`;
  const [r] = await sql.unsafe<{ rows: string; checksum: string | null }[]>(
    `select count(*)::text as rows, coalesce(sum(('x' || substr(md5(${row}), 1, 15))::bit(60)::bigint::numeric), 0)::text as checksum from ${qident(table)} t`,
  );
  return { rows: Number(r.rows), checksum: r.checksum ?? "0" };
}

export interface VerifyRow {
  table: string;
  side: Side;
  sourceRows: number;
  targetRows: number;
  sourceChecksum: string;
  targetChecksum: string;
  ok: boolean;
}

export async function verifyCopy(source: Sql, target: Sql, side: Side, tables = tablesOwnedBy(side)): Promise<VerifyRow[]> {
  const out: VerifyRow[] = [];
  for (const table of tables) {
    const columns = await copyableColumns(source, table);
    const [a, b] = await Promise.all([fingerprint(source, table, columns), fingerprint(target, table, columns)]);
    out.push({ table, side, sourceRows: a.rows, targetRows: b.rows, sourceChecksum: a.checksum, targetChecksum: b.checksum, ok: a.rows === b.rows && a.checksum === b.checksum });
  }
  return out;
}

export interface OrphanRow {
  constraint: string;
  child: string;
  columns: string[];
  parent: string;
  childSide: Side;
  parentSide: Side;
  checkedValues: number;
  orphans: number;
}

/**
 * For every relationship that now spans the two databases: how many distinct
 * child values have no parent row on the other side. Zero everywhere means
 * the split kept every order → shop → product link intact.
 */
export async function checkCrossReferences(seller: Sql, customer: Sql, fks: ForeignKey[]): Promise<OrphanRow[]> {
  const sides: Record<Side, Sql> = { seller, customer };
  const out: OrphanRow[] = [];
  for (const fk of crossDbReferences(fks)) {
    if (fk.columns.length !== 1) continue; // every cross-database link today is a single uuid column
    const child = sides[fk.from];
    const parent = sides[fk.to];
    const values = (
      await child.unsafe<{ v: string }[]>(`select distinct ${ident(fk.columns[0])}::text as v from ${qident(fk.table)} where ${ident(fk.columns[0])} is not null`)
    ).map((r) => r.v);
    let orphans = 0;
    for (let i = 0; i < values.length; i += 5000) {
      const chunk = values.slice(i, i + 5000);
      const [{ n }] = await parent.unsafe<{ n: number }[]>(
        `select count(*)::int as n from unnest($1::text[]) v(id) where not exists (select 1 from ${qident(fk.refTable)} p where p.${ident(fk.refColumns[0])}::text = v.id)`,
        [chunk],
      );
      orphans += n;
    }
    out.push({ constraint: fk.name, child: fk.table, columns: fk.columns, parent: fk.refTable, childSide: fk.from, parentSide: fk.to, checkedValues: values.length, orphans });
  }
  return out;
}

/* ------------------------------------------------------------ cross-database reads */

/**
 * postgres_fdw: makes the listed tables of `remoteUrl` readable inside the
 * database `local` is connected to, under `schema` (e.g. seller_remote). Run
 * by a role that may create extensions (Neon: the database owner).
 */
export async function setupForeignTables(local: Sql, options: { serverName: string; remoteUrl: string; schema: string; tables: readonly string[] }): Promise<void> {
  const u = new URL(options.remoteUrl);
  const opt = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const sslmode = u.searchParams.get("sslmode");
  await local.unsafe(`create extension if not exists postgres_fdw`);
  await local.unsafe(`create schema if not exists ${ident(options.schema)}`);
  await local.unsafe(`drop server if exists ${ident(options.serverName)} cascade`);
  await local.unsafe(
    `create server ${ident(options.serverName)} foreign data wrapper postgres_fdw options (host ${opt(u.hostname)}, port ${opt(u.port || "5432")}, dbname ${opt(decodeURIComponent(u.pathname.replace(/^\//, "")))}${sslmode && sslmode !== "disable" ? `, sslmode ${opt(sslmode)}` : ""})`,
  );
  await local.unsafe(
    `create user mapping for current_user server ${ident(options.serverName)} options (user ${opt(decodeURIComponent(u.username || "postgres"))}${u.password ? `, password ${opt(decodeURIComponent(u.password))}` : ""})`,
  );
  await local.unsafe(
    `import foreign schema public limit to (${options.tables.map(ident).join(", ")}) from server ${ident(options.serverName)} into ${ident(options.schema)}`,
  );
}
