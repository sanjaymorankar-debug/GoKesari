/**
 * The "overlay" split layout (docs/db-split-2026-10/CODE_SPLIT_PLAN.md): the
 * seller tables live in the seller database; the core (customer) database
 * keeps foreign tables of the same names pointing at them through
 * postgres_fdw, so the application keeps a single connection and its SQL —
 * joins, transactions, row locks — still works, while the data is physically
 * in two databases.
 *
 * The core's own copies of the seller tables are parked, not dropped, so the
 * switch can be undone without losing a row (switch.ts → switchBack).
 *
 * What PostgreSQL cannot do across the two, and the code must not rely on:
 *   - foreign keys between a seller table and a core table (dropped here; the
 *     service layer checks them — src/server/db/split/integrity.ts);
 *   - INSERT … ON CONFLICT with a conflict target, and ON CONFLICT DO UPDATE,
 *     on a seller table (postgres_fdw cannot see the remote unique index).
 */
import * as splitMigrate from "../../../../scripts/split-migrate.mjs";
import { physicalDatabase } from "./ownership";
import { listForeignKeys, publicTables, type ForeignKey, type Sql } from "./tools";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qident = (name: string) => (name.includes(".") ? name.split(".").map(ident).join(".") : ident(name));
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

export const OVERLAY_SERVER: string = splitMigrate.SELLER_SERVER;
/** The server, in the seller database, that points back at the core. */
export const CORE_SERVER: string = splitMigrate.CORE_SERVER;

export interface OwnedSequence {
  sequence: string;
  table: string;
  column: string;
  /** An identity column (no column default of its own). */
  identity: boolean;
}

export interface OverlayPlan {
  /** Seller tables: "name" in public, "schema.name" in an owned schema (pmd). */
  tables: string[];
  /** Whole schemas that move (pmd). */
  schemas: string[];
  /** Foreign keys with one end in a seller table and the other in a core table. */
  crossForeignKeys: ForeignKey[];
  /** Every foreign key of the single-database layout (child → parent), recorded in the core. */
  allForeignKeys: ForeignKey[];
  /** Sequences behind seller-table defaults; they stay in the core so its foreign tables can draw ids. */
  sequences: OwnedSequence[];
  /** Other sequences in a moving schema (pmd), kept in the core with their values. */
  standaloneSequences: string[];
}

export async function buildOverlayPlan(core: Sql): Promise<OverlayPlan> {
  const tables = (await publicTables(core)).filter((t) => physicalDatabase(t) === "seller");
  const schemas = [...new Set(tables.filter((t) => t.includes(".")).map((t) => t.split(".")[0]))];
  const fks = await listForeignKeys(core);
  const sellerSet = new Set(tables);
  const crossForeignKeys = fks.filter((fk) => sellerSet.has(fk.table) !== sellerSet.has(fk.refTable));
  // Sequences owned by a seller column (serial / identity) or used by a seller column's default.
  const seqRows = await core<{ sequence: string; table: string; column: string; identity: boolean }[]>`
    select s.oid::regclass::text as sequence, t.oid::regclass::text as table, a.attname as column, d.deptype = 'i' as identity
    from pg_depend d
    join pg_class s on s.oid = d.objid and s.relkind = 'S'
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where d.deptype in ('a', 'i')
    union
    select s.oid::regclass::text, t.oid::regclass::text, a.attname, false
    from pg_attrdef ad
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_class'::regclass
    join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
    join pg_class t on t.oid = ad.adrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = ad.adnum`;
  const strip = (t: string) => t.replace(/^public\./, "").replace(/"/g, "");
  const sequences = seqRows.map((r) => ({ sequence: strip(r.sequence), table: strip(r.table), column: r.column, identity: r.identity })).filter((r) => sellerSet.has(r.table));
  // Sequences in a moving schema that no default uses (code calls nextval on them directly).
  const schemaSeqs = schemas.length
    ? await core<{ sequence: string }[]>`select c.oid::regclass::text as sequence from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = any(${schemas})`
    : [];
  const standaloneSequences = schemaSeqs.map((r) => strip(r.sequence)).filter((q) => !sequences.some((x) => x.sequence === q));
  return { tables, schemas, crossForeignKeys, allForeignKeys: fks, sequences, standaloneSequences };
}

/** Where the core's own seller tables are kept after the switch, untouched, so a rollback can bring them back. */
export const PARKED_SCHEMA = "split_parked";
/** Moving schemas (pmd) are kept under this prefix. */
export const PARKED_PREFIX = "split_parked_";

/**
 * Applies the overlay to the core database in one transaction: drops the
 * cross-database foreign keys, moves the core's copies of the seller tables
 * out of the way (schema split_parked; whole schemas renamed
 * split_parked_<name>), then imports the seller tables back as foreign tables
 * (with their column defaults) under the same names.
 */
export async function applyOverlay(core: Sql, sellerUrl: string, plan: OverlayPlan, log: (line: string) => void = () => undefined, seller?: Sql): Promise<void> {
  if (seller) {
    await acceptCoreIds(seller, log);
    await pinFunctionSearchPath(seller, log);
  }
  await core.begin((tx) => overlayInTransaction(tx as unknown as Sql, sellerUrl, plan, log));
}

/** The overlay, inside the caller's core transaction (the switch holds its write locks across the copy). */
export async function overlayInTransaction(tx: Sql, sellerUrl: string, plan: OverlayPlan, log: (line: string) => void = () => undefined): Promise<void> {
  const publicSeller = plan.tables.filter((t) => !t.includes("."));
  const [{ parked }] = await tx<{ parked: number }[]>`
    select count(*)::int as parked from pg_namespace where nspname = ${PARKED_SCHEMA} or nspname like ${`${PARKED_PREFIX}%`}`;
  if (parked) throw new Error(`The core still holds a parked copy from an earlier switch (schema ${PARKED_SCHEMA}*). Drop it first (scripts/db-split/switch.ts drop-parked).`);
  await tx.unsafe(`create extension if not exists postgres_fdw`);
  // The relationships of the single-database layout, kept for `verify`, the rollback and the test reset's cascade.
  await tx.unsafe(`create table if not exists public.split_layout_foreign_keys (name text not null, child text not null, parent text not null, definition text not null, cross_database boolean not null)`);
  await tx.unsafe(`truncate public.split_layout_foreign_keys`);
  const crossNames = new Set(plan.crossForeignKeys.map((fk) => `${fk.table}.${fk.name}`));
  for (const fk of plan.allForeignKeys) {
    await tx`insert into public.split_layout_foreign_keys (name, child, parent, definition, cross_database) values (${fk.name}, ${fk.table}, ${fk.refTable}, ${fk.definition}, ${crossNames.has(`${fk.table}.${fk.name}`)})`;
  }
  for (const fk of plan.crossForeignKeys) await tx.unsafe(`alter table ${qident(fk.table)} drop constraint if exists ${ident(fk.name)}`);
  log(`dropped ${plan.crossForeignKeys.length} cross-database foreign keys`);

  // Remember the sequences' current values; they are re-created in the core below.
  const values = new Map<string, bigint>();
  for (const s of [...plan.sequences, ...plan.standaloneSequences.map((sequence) => ({ sequence }))]) {
    if (values.has(s.sequence)) continue;
    const [{ v }] = await tx.unsafe<{ v: bigint }[]>(`select last_value as v from ${qident(s.sequence)}`);
    values.set(s.sequence, v);
  }

  await tx.unsafe(`create schema ${ident(PARKED_SCHEMA)}`);
  for (const t of publicSeller) await tx.unsafe(`alter table ${ident(t)} set schema ${ident(PARKED_SCHEMA)}`);
  for (const schema of plan.schemas) await tx.unsafe(`alter schema ${ident(schema)} rename to ${ident(PARKED_PREFIX + schema)}`);
  log(`parked the core's ${publicSeller.length} seller tables in ${PARKED_SCHEMA} and schemas ${plan.schemas.map((x) => `${x} → ${PARKED_PREFIX}${x}`).join(", ") || "(none)"}`);

  const options = splitMigrate.fdwOptions(sellerUrl);
  await tx.unsafe(`drop server if exists ${ident(OVERLAY_SERVER)} cascade`);
  await tx.unsafe(`create server ${ident(OVERLAY_SERVER)} foreign data wrapper postgres_fdw options (${options.server})`);
  await tx.unsafe(`create user mapping for current_user server ${ident(OVERLAY_SERVER)} options (${options.user})`);

  // The core draws ids for the seller tables (postgres_fdw sends every column on insert).
  for (const schema of plan.schemas) await tx.unsafe(`create schema if not exists ${ident(schema)}`);
  for (const [seq, v] of values) {
    await tx.unsafe(`create sequence if not exists ${qident(seq)}`);
    await tx.unsafe(`select setval(${literal(qident(seq))}, ${v}, true)`);
  }

  if (publicSeller.length) {
    await tx.unsafe(
      `import foreign schema public limit to (${publicSeller.map(ident).join(", ")}) from server ${ident(OVERLAY_SERVER)} into public options (import_default 'true')`,
    );
  }
  for (const schema of plan.schemas) {
    await tx.unsafe(`import foreign schema ${ident(schema)} from server ${ident(OVERLAY_SERVER)} into ${ident(schema)} options (import_default 'true')`);
  }
  // Identity columns arrive without a default (import_default only carries real defaults, which already
  // name the core's sequences — including composite ones like 'BKS-' || lpad(nextval(...))): give them one.
  for (const s of plan.sequences.filter((x) => x.identity)) {
    await tx.unsafe(`alter foreign table ${qident(s.table)} alter column ${ident(s.column)} set default nextval(${literal(qident(s.sequence))})`);
  }
  log(`imported ${plan.tables.length} seller tables as foreign tables`);
}

/* The seller-side steps live in scripts/split-migrate.mjs (plain Node, so the host's build can run them too). */

/** In the seller database, identity columns accept the ids the core draws. */
export async function acceptCoreIds(seller: Sql, log: (line: string) => void = () => undefined): Promise<void> {
  const n: number = await splitMigrate.acceptCoreIds(seller);
  if (n) log(`seller: ${n} identity columns now accept ids from the core`);
}

/** postgres_fdw sessions use search_path = pg_catalog; seller functions get the site's own path. */
export async function pinFunctionSearchPath(seller: Sql, log: (line: string) => void = () => undefined): Promise<void> {
  const n: number = await splitMigrate.pinFunctionSearchPath(seller);
  if (n) log(`seller: ${n} functions pinned to search_path "$user", public`);
}

/** In the seller database: the core tables its code and triggers use, as foreign tables pointing back at the core. */
export async function linkSellerToCore(seller: Sql, coreUrl: string, log: (line: string) => void = () => undefined): Promise<void> {
  await splitMigrate.linkSellerToCore(seller, coreUrl);
  log(`seller: ${splitMigrate.SELLER_LINKED_CORE_TABLES.length} core tables linked (${splitMigrate.SELLER_LINKED_CORE_TABLES.join(", ")})`);
}
