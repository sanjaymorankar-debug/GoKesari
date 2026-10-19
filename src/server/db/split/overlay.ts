/**
 * The "overlay" split layout (docs/db-split-2026-10/CODE_SPLIT_PLAN.md): the
 * seller tables live in the seller database; the core (customer) database
 * keeps foreign tables of the same names pointing at them through
 * postgres_fdw, so the application keeps a single connection and its SQL —
 * joins, transactions, row locks — still works, while the data is physically
 * in two databases.
 *
 * What PostgreSQL cannot do across the two, and the code must not rely on:
 *   - foreign keys between a seller table and a core table (dropped here; the
 *     service layer checks them — src/server/db/split/integrity.ts);
 *   - INSERT … ON CONFLICT with a conflict target, and ON CONFLICT DO UPDATE,
 *     on a seller table (postgres_fdw cannot see the remote unique index).
 */
import { physicalDatabase, SELLER_READS_FROM_CORE, SELLER_WRITES_TO_CORE } from "./ownership";
import { listForeignKeys, publicTables, type ForeignKey, type Sql } from "./tools";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qident = (name: string) => (name.includes(".") ? name.split(".").map(ident).join(".") : ident(name));
const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

export const OVERLAY_SERVER = "gk_seller";
/** The server, in the seller database, that points back at the core. */
export const CORE_SERVER = "gk_core";

export interface OwnedSequence {
  sequence: string;
  table: string;
  column: string;
}

export interface OverlayPlan {
  /** Seller tables: "name" in public, "schema.name" in an owned schema (pmd). */
  tables: string[];
  /** Whole schemas that move (pmd). */
  schemas: string[];
  /** Foreign keys with one end in a seller table and the other in a core table. */
  crossForeignKeys: ForeignKey[];
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
  const seqRows = await core<{ sequence: string; table: string; column: string }[]>`
    select s.oid::regclass::text as sequence, t.oid::regclass::text as table, a.attname as column
    from pg_depend d
    join pg_class s on s.oid = d.objid and s.relkind = 'S'
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where d.deptype in ('a', 'i')
    union
    select s.oid::regclass::text, t.oid::regclass::text, a.attname
    from pg_attrdef ad
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_class'::regclass
    join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
    join pg_class t on t.oid = ad.adrelid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = ad.adnum`;
  const strip = (t: string) => t.replace(/^public\./, "").replace(/"/g, "");
  const sequences = seqRows.map((r) => ({ sequence: strip(r.sequence), table: strip(r.table), column: r.column })).filter((r) => sellerSet.has(r.table));
  // Sequences in a moving schema that no default uses (code calls nextval on them directly).
  const schemaSeqs = schemas.length
    ? await core<{ sequence: string }[]>`select c.oid::regclass::text as sequence from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = any(${schemas})`
    : [];
  const standaloneSequences = schemaSeqs.map((r) => strip(r.sequence)).filter((q) => !sequences.some((x) => x.sequence === q));
  return { tables, schemas, crossForeignKeys, sequences, standaloneSequences };
}

/**
 * Applies the overlay to the core database in one transaction: drops the
 * cross-database foreign keys and the core's copies of the seller tables,
 * then imports the seller tables back as foreign tables (with their column
 * defaults) under the same names.
 */
export async function applyOverlay(core: Sql, sellerUrl: string, plan: OverlayPlan, log: (line: string) => void = () => undefined, seller?: Sql): Promise<void> {
  if (seller) await acceptCoreIds(seller, log);
  const u = new URL(sellerUrl);
  const sslmode = u.searchParams.get("sslmode");
  const publicSeller = plan.tables.filter((t) => !t.includes("."));
  await core.begin(async (tx) => {
    await tx.unsafe(`create extension if not exists postgres_fdw`);
    for (const fk of plan.crossForeignKeys) await tx.unsafe(`alter table ${qident(fk.table)} drop constraint if exists ${ident(fk.name)}`);
    log(`dropped ${plan.crossForeignKeys.length} cross-database foreign keys`);

    // Remember the sequences' current values; they are re-created in the core below.
    const values = new Map<string, bigint>();
    for (const s of [...plan.sequences, ...plan.standaloneSequences.map((sequence) => ({ sequence }))]) {
      if (values.has(s.sequence)) continue;
      const [{ v }] = await tx.unsafe<{ v: bigint }[]>(`select last_value as v from ${qident(s.sequence)}`);
      values.set(s.sequence, v);
    }

    for (const t of publicSeller) await tx.unsafe(`drop table if exists ${ident(t)} cascade`);
    for (const schema of plan.schemas) await tx.unsafe(`drop schema if exists ${ident(schema)} cascade`);
    log(`dropped the core's ${publicSeller.length} seller tables and schemas ${plan.schemas.join(", ") || "(none)"}`);

    await tx.unsafe(`drop server if exists ${ident(OVERLAY_SERVER)} cascade`);
    await tx.unsafe(
      `create server ${ident(OVERLAY_SERVER)} foreign data wrapper postgres_fdw options (host ${literal(u.hostname)}, port ${literal(u.port || "5432")}, dbname ${literal(decodeURIComponent(u.pathname.replace(/^\//, "")))}, fetch_size '1000'${sslmode && sslmode !== "disable" ? `, sslmode ${literal(sslmode)}` : ""})`,
    );
    await tx.unsafe(
      `create user mapping for current_user server ${ident(OVERLAY_SERVER)} options (user ${literal(decodeURIComponent(u.username || "postgres"))}${u.password ? `, password ${literal(decodeURIComponent(u.password))}` : ""})`,
    );

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
    for (const s of plan.sequences) {
      await tx.unsafe(`alter foreign table ${qident(s.table)} alter column ${ident(s.column)} set default nextval(${literal(qident(s.sequence))})`);
    }
    log(`imported ${plan.tables.length} seller tables as foreign tables`);
  });
}

/**
 * In the seller database, identity columns declared GENERATED ALWAYS become
 * GENERATED BY DEFAULT, so the ids the core draws for them are accepted.
 */
export async function acceptCoreIds(seller: Sql, log: (line: string) => void = () => undefined): Promise<void> {
  const rows = await seller<{ schema: string; table: string; column: string }[]>`
    select table_schema as schema, table_name as table, column_name as column from information_schema.columns
    where is_identity = 'YES' and identity_generation = 'ALWAYS' and table_schema in ('public', 'pmd')`;
  for (const r of rows) await seller.unsafe(`alter table ${ident(r.schema)}.${ident(r.table)} alter column ${ident(r.column)} set generated by default`);
  if (rows.length) log(`seller: ${rows.length} identity columns now accept ids from the core`);
}

/**
 * In the seller database: the few core tables that code talking to the
 * seller database directly needs (users, settings, roles; the audit log),
 * as foreign tables pointing back at the core.
 */
export async function linkSellerToCore(seller: Sql, coreUrl: string, log: (line: string) => void = () => undefined): Promise<void> {
  const u = new URL(coreUrl);
  const sslmode = u.searchParams.get("sslmode");
  const tables = [...SELLER_READS_FROM_CORE, ...SELLER_WRITES_TO_CORE];
  await seller.begin(async (tx) => {
    await tx.unsafe(`create extension if not exists postgres_fdw`);
    for (const t of tables) await tx.unsafe(`drop table if exists ${ident(t)} cascade`);
    for (const t of tables) await tx.unsafe(`drop foreign table if exists ${ident(t)} cascade`);
    await tx.unsafe(`drop server if exists ${ident(CORE_SERVER)} cascade`);
    await tx.unsafe(
      `create server ${ident(CORE_SERVER)} foreign data wrapper postgres_fdw options (host ${literal(u.hostname)}, port ${literal(u.port || "5432")}, dbname ${literal(decodeURIComponent(u.pathname.replace(/^\//, "")))}, fetch_size '1000'${sslmode && sslmode !== "disable" ? `, sslmode ${literal(sslmode)}` : ""})`,
    );
    await tx.unsafe(
      `create user mapping for current_user server ${ident(CORE_SERVER)} options (user ${literal(decodeURIComponent(u.username || "postgres"))}${u.password ? `, password ${literal(decodeURIComponent(u.password))}` : ""})`,
    );
    await tx.unsafe(`import foreign schema public limit to (${tables.map(ident).join(", ")}) from server ${ident(CORE_SERVER)} into public options (import_default 'true')`);
  });
  log(`seller: ${tables.length} core tables linked (${tables.join(", ")})`);
}

