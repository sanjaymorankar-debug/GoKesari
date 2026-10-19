/**
 * Switching a site's database to the split layout, and back again
 * (docs/db-split-2026-10/CODE_SPLIT_PLAN.md §5). Used by
 * scripts/db-split/switch.ts and the "Database split" workflow.
 *
 * switchToSplit copies every seller table into the seller database while
 * writes to those tables wait (reads go on), proves the copy row for row,
 * links the two databases, and replaces the core's seller tables with foreign
 * tables — all inside one core transaction, so no write is lost and nothing
 * changes if any step fails. The core's own copies are parked, not dropped.
 *
 * switchBack is the reverse, keeping every row written since: the parked
 * tables come back, are reloaded from the seller database, and get their
 * foreign keys back; the link is removed.
 *
 * The site needs no setting changed at the moment of either step: with
 * DB_SPLIT_MODE=split it looks at the database to decide whether to use the
 * seller database directly (src/server/pmd/db.ts).
 */
import { pipeline } from "node:stream/promises";

import type postgres from "postgres";

import * as splitMigrate from "../../../../scripts/split-migrate.mjs";
import { acceptCoreIds, buildOverlayPlan, linkSellerToCore, OVERLAY_SERVER, overlayInTransaction, PARKED_PREFIX, PARKED_SCHEMA, pinFunctionSearchPath } from "./overlay";
import { SCHEMA_OWNERSHIP } from "./ownership";
import { copyableColumns, copyTables, listForeignKeys, prepareTarget, publicTables, sameDatabaseClash, verifyCopy, type Sql } from "./tools";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qident = (name: string) => (name.includes(".") ? name.split(".").map(ident).join(".") : ident(name));

type Log = (line: string) => void;

export interface Check {
  ready: boolean;
  /** Each one stops the step. */
  problems: string[];
  /** What the step will do. */
  notes: string[];
}

export interface SwitchOptions {
  core: Sql;
  seller: Sql;
  coreUrl: string;
  sellerUrl: string;
  log?: Log;
  /** A fresh one-connection client per table read (see CopyOptions.openReader); remote runs pass one. */
  openReader?: () => Sql;
  tableTimeoutMs?: number;
  /** How long to wait for the locks before giving up (nothing is changed then). */
  lockTimeoutMs?: number;
  migrationsFolder?: string;
}

async function parkedSchemas(core: Sql): Promise<string[]> {
  const rows = await core<{ name: string }[]>`
    select nspname as name from pg_namespace where nspname = ${PARKED_SCHEMA} or nspname like ${`${PARKED_PREFIX}%`} order by 1`;
  return rows.map((r) => r.name);
}

async function rowCount(sql: Sql, table: string): Promise<number> {
  const [{ n }] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${qident(table)}`);
  return n;
}

class ProbeDone extends Error {}

/**
 * Whether `from` can reach the database at `toUrl` through postgres_fdw, the
 * way the switch will link them (a Neon IP allow-list or a wrong password
 * shows up here). Everything it creates is rolled back. Null when it can.
 */
async function probeLink(from: Sql, toUrl: string): Promise<string | null> {
  const options = splitMigrate.fdwOptions(toUrl);
  try {
    await from.begin(async (tx) => {
      await tx.unsafe(`create extension if not exists postgres_fdw`);
      await tx.unsafe(`create server gk_probe foreign data wrapper postgres_fdw options (${options.server})`);
      await tx.unsafe(`create user mapping for current_user server gk_probe options (${options.user})`);
      await tx.unsafe(`create foreign table gk_probe_namespaces (nspname name) server gk_probe options (schema_name 'pg_catalog', table_name 'pg_namespace')`);
      await tx.unsafe(`select count(*) from gk_probe_namespaces`);
      throw new ProbeDone();
    });
  } catch (error) {
    if (error instanceof ProbeDone) return null;
    const e = error as { message?: string; detail?: string };
    return [e.message, e.detail].filter(Boolean).join(" — ");
  }
  return null;
}

/** Read-only: which layout the core is on, and whether it still keeps a parked copy. */
export async function layoutStatus(core: Sql): Promise<{ layout: "split" | "single"; parked: string[] }> {
  return { layout: (await splitMigrate.isSplitLayout(core)) ? "split" : "single", parked: await parkedSchemas(core) };
}

/* ------------------------------------------------------------ to the split */

/** Read-only: whether the site can be switched now, and what the switch would do. */
export async function checkSwitch(core: Sql, seller: Sql, urls: { core: string; seller: string }, migrationsFolder = "./drizzle"): Promise<Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  const clash = sameDatabaseClash({ CORE: urls.core, SELLER: urls.seller });
  if (clash) problems.push(`The core and the seller database are the same database (${clash}).`);
  if (await splitMigrate.isSplitLayout(core)) problems.push("The core is already on the split layout.");
  const parked = await parkedSchemas(core);
  if (parked.length) problems.push(`The core still holds a parked copy from an earlier switch (${parked.join(", ")}); drop it first (drop-parked).`);

  const journal = splitMigrate.readMigrations(migrationsFolder);
  const [{ applied }] = await core<{ applied: string | null }[]>`
    select case when to_regclass('drizzle.__drizzle_migrations') is null then null else (select max(created_at)::text from drizzle.__drizzle_migrations) end as applied`;
  if (applied === null || Number(applied) < journal[journal.length - 1].when) {
    problems.push("The core has migrations still to apply: deploy this version of the site first.");
  }
  for (const [name, sql] of [
    ["core", core],
    ["seller", seller],
  ] as const) {
    const [{ fdw }] = await sql<{ fdw: boolean }[]>`select exists (select 1 from pg_available_extensions where name = 'postgres_fdw') as fdw`;
    if (!fdw) problems.push(`The ${name} database's server does not offer postgres_fdw.`);
  }
  if (problems.length === 0) {
    const toSeller = await probeLink(core, urls.seller);
    if (toSeller) problems.push(`The core cannot reach the seller database through postgres_fdw: ${toSeller}`);
    const toCore = await probeLink(seller, urls.core);
    if (toCore) problems.push(`The seller database cannot reach the core through postgres_fdw: ${toCore}`);
  }
  // The seller database is emptied and rebuilt: make sure it is not a site's database.
  const live = await seller<{ name: string; rows: number }[]>`
    select t.table_name as name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', t.table_name), false, true, '')))[1]::text::int as rows
    from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name in ('users', 'orders')`;
  for (const t of live.filter((x) => x.rows > 0)) problems.push(`The seller database has its own "${t.name}" table with ${t.rows} rows — it looks like a site's database, not the seller database. Check SELLER_DATABASE_URL.`);

  if (problems.length === 0) {
    const plan = await buildOverlayPlan(core);
    let rows = 0;
    for (const t of plan.tables) rows += await rowCount(core, t);
    notes.push(`${plan.tables.length} seller tables (${rows} rows) move to the seller database; the core keeps foreign tables of the same names.`);
    notes.push(`${plan.crossForeignKeys.length} foreign keys between seller and customer tables are recorded and checked by the code instead.`);
    const existing = (await publicTables(seller)).length;
    notes.push(existing ? `The seller database's ${existing} existing tables are replaced (rebuilt from the migrations).` : "The seller database is empty; it is built from the migrations.");
    notes.push("While the rows are copied, writes to seller tables wait; reads go on. Nothing changes if any step fails.");
  }
  return { ready: problems.length === 0, problems, notes };
}

/** Empties the seller database (its tables are rebuilt from the migrations). */
async function emptySellerDatabase(seller: Sql): Promise<void> {
  await seller.unsafe(`drop extension if exists postgres_fdw cascade`);
  for (const schema of ["drizzle", ...Object.keys(SCHEMA_OWNERSHIP)]) await seller.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  await seller.unsafe(`drop schema if exists public cascade`);
  await seller.unsafe(`create schema public`);
}

export interface SwitchResult {
  tables: number;
  rows: number;
  /** How long writes to the seller tables waited. */
  writesPausedSeconds: number;
  seconds: number;
}

export async function switchToSplit(o: SwitchOptions): Promise<SwitchResult> {
  const log = o.log ?? (() => undefined);
  const started = Date.now();
  const check = await checkSwitch(o.core, o.seller, { core: o.coreUrl, seller: o.sellerUrl }, o.migrationsFolder);
  if (!check.ready) throw new Error(check.problems.join(" "));

  await emptySellerDatabase(o.seller);
  const prepared = await prepareTarget(o.seller, "seller", { replace: true, migrationsFolder: o.migrationsFolder });
  log(`seller database built from the migrations: ${prepared.keptTables.length} tables`);

  let rows = 0;
  let tables = 0;
  let paused = 0;
  await o.core.begin(async (txn) => {
    const tx = txn as unknown as Sql;
    await tx.unsafe(`set local lock_timeout = ${Math.round(o.lockTimeoutMs ?? 15_000)}`);
    const plan = await buildOverlayPlan(tx);
    await tx.unsafe(`lock table ${plan.tables.map(qident).join(", ")} in exclusive mode`);
    const pausedAt = Date.now();
    log(`writes to the ${plan.tables.length} seller tables are paused (reads go on)`);

    await copyTables(o.core, o.seller, plan.tables, log, { openReader: o.openReader, tableTimeoutMs: o.tableTimeoutMs });
    const verify = await verifyCopy(o.core, o.seller, "seller", plan.tables);
    const bad = verify.filter((v) => !v.ok);
    if (bad.length) throw new Error(`The copy does not match the core: ${bad.map((b) => `${b.table} (${b.sourceRows} → ${b.targetRows} rows)`).join(", ")}. Nothing was switched.`);
    rows = verify.reduce((n, v) => n + v.sourceRows, 0);
    tables = verify.length;
    log(`copy verified: ${tables} tables, ${rows} rows, row counts and checksums match`);

    await acceptCoreIds(o.seller, log);
    await pinFunctionSearchPath(o.seller, log);
    await linkSellerToCore(o.seller, o.coreUrl, log);
    await overlayInTransaction(tx, o.sellerUrl, plan, log);

    // Prove the link before committing: every seller table, read through the core, has the copied rows.
    for (const v of verify) {
      const n = await rowCount(tx, v.table);
      if (n !== v.sourceRows) throw new Error(`${v.table} reads ${n} rows through the core, ${v.sourceRows} were copied. Nothing was switched.`);
    }
    log("every seller table reads back through the core with the copied rows");
    paused = (Date.now() - pausedAt) / 1000;
  });
  const repaired = await splitMigrate.reconcile({ core: o.core, seller: o.seller, coreUrl: o.coreUrl, log });
  if (repaired.length) log(`after the switch: ${repaired.join("; ")}`);
  return { tables, rows, writesPausedSeconds: Math.round(paused), seconds: Math.round((Date.now() - started) / 1000) };
}

/* ------------------------------------------------------------ back to one database */

const parkedName = (table: string) => (table.includes(".") ? `${PARKED_PREFIX}${table}` : `${PARKED_SCHEMA}.${table}`);

async function columnList(sql: Sql, table: string): Promise<string> {
  const [schema, name] = table.includes(".") ? table.split(".") : ["public", table];
  const rows = await sql<{ c: string }[]>`
    select column_name || ':' || data_type as c from information_schema.columns where table_schema = ${schema} and table_name = ${name} order by column_name`;
  return rows.map((r) => r.c).join(",");
}

/** Read-only: whether the switch can be undone without losing anything, and what that does. */
export async function checkSwitchBack(core: Sql, seller: Sql): Promise<Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!(await splitMigrate.isSplitLayout(core))) problems.push("The core is not on the split layout; there is nothing to switch back.");
  const parked = await parkedSchemas(core);
  if (!parked.includes(PARKED_SCHEMA)) problems.push(`The core has no parked copy (${PARKED_SCHEMA}) to bring back; restore from a Neon restore point instead.`);
  if (problems.length) return { ready: false, problems, notes };

  const tables = await publicTables(seller);
  const changed: string[] = [];
  for (const t of tables) {
    const parkedCols = await columnList(core, parkedName(t));
    if (!parkedCols) changed.push(`${t} (new since the switch)`);
    else if (parkedCols !== (await columnList(seller, t))) changed.push(`${t} (columns changed since the switch)`);
  }
  if (changed.length) {
    problems.push(`A migration changed seller tables after the switch: ${changed.join(", ")}. Switching back would lose that change; restore from a Neon restore point instead.`);
  }
  let rows = 0;
  for (const t of tables) rows += await rowCount(seller, t);
  notes.push(`${tables.length} seller tables (${rows} rows) come back into the core with every row written since the switch.`);
  notes.push("While they are reloaded, requests that use seller tables wait. Nothing changes if any step fails.");
  notes.push("Set DB_SPLIT_MODE=single on the site before switching back, so nothing writes to the seller database directly while it is copied.");
  return { ready: problems.length === 0, problems, notes };
}

export interface SwitchBackResult {
  tables: number;
  rows: number;
  /** Foreign keys whose existing rows break them: kept for new rows (NOT VALID), listed for a fix. */
  orphanedForeignKeys: string[];
  seconds: number;
}

export async function switchBack(o: Omit<SwitchOptions, "coreUrl" | "sellerUrl" | "migrationsFolder">): Promise<SwitchBackResult> {
  const log = o.log ?? (() => undefined);
  const started = Date.now();
  const check = await checkSwitchBack(o.core, o.seller);
  if (!check.ready) throw new Error(check.problems.join(" "));
  const lockTimeout = Math.round(o.lockTimeoutMs ?? 15_000);

  const tables = await publicTables(o.seller);
  const tableSet = new Set(tables);
  const publicNames = tables.filter((t) => !t.includes("."));
  const schemas = [...new Set(tables.filter((t) => t.includes(".")).map((t) => t.split(".")[0]))];
  const orphanedForeignKeys: string[] = [];
  let rows = 0;

  await o.seller.begin(async (sellerTxn) => {
    const sellerTx = sellerTxn as unknown as Sql;
    await o.core.begin(async (txn) => {
      const tx = txn as unknown as Sql;
      await tx.unsafe(`set local lock_timeout = ${lockTimeout}`);

      // 1. The core's foreign tables go; requests that use seller tables wait from here on.
      const sequences = await tx<{ schema: string; name: string }[]>`
        select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'S' and (n.nspname = ${PARKED_SCHEMA} or n.nspname like ${`${PARKED_PREFIX}%`})`;
      const drawn = new Map<string, { value: string; called: boolean }>();
      for (const s of sequences) {
        const live = `${s.schema === PARKED_SCHEMA ? "public" : s.schema.slice(PARKED_PREFIX.length)}.${s.name}`;
        const [{ exists }] = await tx<{ exists: boolean }[]>`select to_regclass(${qident(live)}) is not null as exists`;
        if (!exists) continue;
        const [state] = await tx.unsafe<{ value: string; called: boolean }[]>(`select last_value::text as value, is_called as called from ${qident(live)}`);
        drawn.set(live, state);
      }
      for (const t of publicNames) await tx.unsafe(`drop foreign table if exists ${ident(t)}`);
      for (const s of schemas) await tx.unsafe(`drop schema if exists ${ident(s)} cascade`);
      for (const live of drawn.keys()) if (live.startsWith("public.")) await tx.unsafe(`drop sequence if exists ${qident(live)}`);
      log("the core's foreign tables are removed; requests that use seller tables wait");

      // 2. Writes straight to the seller database wait too.
      await sellerTx.unsafe(`set local lock_timeout = ${lockTimeout}`);
      await sellerTx.unsafe(`lock table ${tables.map(qident).join(", ")} in exclusive mode`);

      // 3. The parked tables come back and are reloaded with the seller database's rows.
      for (const t of publicNames) await tx.unsafe(`alter table ${qident(parkedName(t))} set schema public`);
      for (const s of schemas) await tx.unsafe(`alter schema ${ident(PARKED_PREFIX + s)} rename to ${ident(s)}`);
      const inner = (await listForeignKeys(tx)).filter((fk) => tableSet.has(fk.table) && tableSet.has(fk.refTable));
      for (const fk of inner) await tx.unsafe(`alter table ${qident(fk.table)} drop constraint ${ident(fk.name)}`);
      await tx.unsafe(`truncate ${tables.map(qident).join(", ")}`);
      for (const t of tables) {
        const list = (await copyableColumns(tx, t)).map(ident).join(", ");
        const reader = o.openReader ? o.openReader() : o.seller;
        try {
          await tx.unsafe(`alter table ${qident(t)} disable trigger user`);
          const readable = await reader.unsafe(`copy (select ${list} from ${qident(t)}) to stdout`).readable();
          const writable = await tx.unsafe(`copy ${qident(t)} (${list}) from stdin`).writable();
          await pipeline(readable, writable);
          await tx.unsafe(`alter table ${qident(t)} enable trigger user`);
        } finally {
          if (reader !== o.seller) await reader.end({ timeout: 0 });
        }
      }
      for (const fk of inner) await tx.unsafe(`alter table ${qident(fk.table)} add constraint ${ident(fk.name)} ${fk.definition}`);
      for (const [live, state] of drawn) await tx.unsafe(`select setval('${qident(live).replace(/'/g, "''")}', ${state.value}, ${state.called})`);

      const verify = await verifyCopy(o.seller, tx, "seller", tables);
      const bad = verify.filter((v) => !v.ok);
      if (bad.length) throw new Error(`The reload does not match the seller database: ${bad.map((b) => b.table).join(", ")}. Nothing was switched back.`);
      rows = verify.reduce((n, v) => n + v.sourceRows, 0);
      log(`reloaded ${tables.length} tables, ${rows} rows; row counts and checksums match the seller database`);

      // 4. The foreign keys between seller and customer tables come back.
      const cross = await tx<{ name: string; child: string; definition: string }[]>`
        select name, child, definition from public.split_layout_foreign_keys where cross_database order by child, name`;
      for (const fk of cross) {
        await tx.unsafe(`alter table ${qident(fk.child)} add constraint ${ident(fk.name)} ${fk.definition} not valid`);
        try {
          await (txn as postgres.TransactionSql).savepoint((sp) => sp.unsafe(`alter table ${qident(fk.child)} validate constraint ${ident(fk.name)}`));
        } catch {
          orphanedForeignKeys.push(`${fk.child}.${fk.name}`);
        }
      }
      log(`restored ${cross.length} foreign keys between seller and customer tables${orphanedForeignKeys.length ? `; ${orphanedForeignKeys.length} have rows that break them (kept for new rows)` : ""}`);

      await tx.unsafe(`drop server if exists ${ident(OVERLAY_SERVER)} cascade`);
      await tx.unsafe(`drop table public.split_layout_foreign_keys`);
      await tx.unsafe(`drop schema ${ident(PARKED_SCHEMA)}`);
    });
  });
  return { tables: tables.length, rows, orphanedForeignKeys, seconds: Math.round((Date.now() - started) / 1000) };
}

/** After the rollback window: frees the parked copy the switch kept in the core. */
export async function dropParked(core: Sql, log: Log = () => undefined): Promise<string[]> {
  if (!(await splitMigrate.isSplitLayout(core))) throw new Error("The core is not on the split layout; its parked copy (if any) is what a switch back needs.");
  const schemas = await parkedSchemas(core);
  for (const s of schemas) await core.unsafe(`drop schema ${ident(s)} cascade`);
  log(schemas.length ? `dropped ${schemas.join(", ")}` : "no parked copy to drop");
  return schemas;
}
