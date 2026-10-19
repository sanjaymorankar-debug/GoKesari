/**
 * Migrations on the seller / customer split layout (docs/db-split-2026-10/CODE_SPLIT_PLAN.md).
 *
 * On one database, drizzle's migrator applies ./drizzle as always. Once a site
 * is split, the seller tables live in the seller database and the core only
 * holds postgres_fdw foreign tables for them, so a migration has to run where
 * its tables are. Every migration written after the split says so on a line of
 * its own:
 *
 *   -- split: seller   seller tables only (applied in the seller database)
 *   -- split: core     customer / platform tables only (applied in the core)
 *   -- split: both     both (types, functions both sides use)
 *
 * The bookkeeping is drizzle's own (same journal, same sha256 hash, same
 * drizzle.__drizzle_migrations table), kept in each database, so a run that
 * stops half way resumes where it stopped. After a seller-side change the core's
 * foreign tables are imported again (new tables and columns appear; sequences
 * and identity columns keep drawing ids in the core), new seller functions get
 * the site's search path, and the seller database's links back to the core are
 * refreshed. Plain Node (postgres only): it runs in the host's build, where
 * development dependencies may be missing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The core tables the seller database reaches through postgres_fdw — must equal SELLER_READS_FROM_CORE + SELLER_WRITES_TO_CORE (ownership.ts; a unit test checks). */
export const SELLER_LINKED_CORE_TABLES = [
  "users",
  "platform_settings",
  "roles",
  "user_role_grants",
  "status_transition_rules",
  "orders",
  "audit_logs",
  "status_changes",
];

/** The postgres_fdw server in the core that points at the seller database, and the one back. */
export const SELLER_SERVER = "gk_seller";
export const CORE_SERVER = "gk_core";

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * postgres_fdw server and user-mapping options for a database URL. The server
 * talks to the database directly, not through Neon's pooler: postgres_fdw sets
 * its session up once per connection (search path, time zone), which a
 * transaction pooler would not keep.
 *
 * @param {string} url
 */
export function fdwOptions(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode");
  const host = u.hostname.replace(/-pooler(?=\.)/, "");
  return {
    server: `host ${literal(host)}, port ${literal(u.port || "5432")}, dbname ${literal(decodeURIComponent(u.pathname.replace(/^\//, "")))}, fetch_size '1000'${sslmode && sslmode !== "disable" ? `, sslmode ${literal(sslmode)}` : ""}`,
    user: `user ${literal(decodeURIComponent(u.username || "postgres"))}${u.password ? `, password ${literal(decodeURIComponent(u.password))}` : ""}`,
  };
}
const SPLIT_TAG = /^--\s*split:\s*(seller|core|both)\b/m;

/**
 * The journal's migrations in order, each with drizzle's hash and where it runs.
 *
 * @param {string} [folder]
 * @returns {{ tag: string, when: number, hash: string, statements: string[], target: "seller" | "core" | "both" | null }[]}
 */
export function readMigrations(folder = "./drizzle") {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((entry) => {
    const query = readFileSync(path.join(folder, `${entry.tag}.sql`), "utf8");
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(query).digest("hex"),
      statements: query.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean),
      target: SPLIT_TAG.exec(query)?.[1] ?? null,
    };
  });
}

/** True when the core is the split layout (it holds foreign tables from the seller server). */
export async function isSplitLayout(core) {
  const [{ n }] = await core`select count(*)::int as n from information_schema.foreign_tables where foreign_server_name = ${SELLER_SERVER}`;
  return n > 0;
}

async function lastApplied(sql) {
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
  const [row] = await sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  return row ? Number(row.created_at) : null;
}

async function record(sql, migration) {
  await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.when})`;
}

/**
 * Applies the pending migrations to the split layout. `core` and `seller` are
 * postgres.js clients; `coreUrl` is how the seller database reaches the core.
 *
 * @param {{ core: import("postgres").Sql, seller: import("postgres").Sql, coreUrl: string, folder?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ applied: string[], repaired: string[] }>}
 */
export async function migrateSplit({ core, seller, coreUrl, folder = "./drizzle", log = () => {} }) {
  const migrations = readMigrations(folder);
  const sellerLast = await lastApplied(seller);
  const coreLast = await lastApplied(core);
  const pending = migrations.filter((m) => (coreLast === null || coreLast < m.when) || (sellerLast === null || sellerLast < m.when));
  if (pending.length === 0) return { applied: [], repaired: await reconcile({ core, seller, coreUrl, log }) };
  const untagged = pending.filter((m) => !m.target);
  if (untagged.length) {
    throw new Error(
      `On the split layout every new migration must say where it runs (a line "-- split: seller", "-- split: core" or "-- split: both"): ${untagged.map((m) => m.tag).join(", ")}.`,
    );
  }
  const applied = [];
  let sellerDone = sellerLast;
  let coreDone = coreLast;
  for (const m of pending) {
    if (sellerDone === null || sellerDone < m.when) {
      await seller.begin(async (tx) => {
        if (m.target !== "core") for (const statement of m.statements) await tx.unsafe(statement);
        await record(tx, m);
      });
      sellerDone = m.when;
      if (m.target !== "core") {
        await acceptCoreIds(seller);
        await pinFunctionSearchPath(seller);
      }
    }
    if (coreDone === null || coreDone < m.when) {
      await core.begin(async (tx) => {
        if (m.target !== "seller") for (const statement of m.statements) await tx.unsafe(statement);
        if (m.target !== "core") await refreshForeignTables(tx, seller);
        await record(tx, m);
      });
      coreDone = m.when;
      if (m.target !== "seller") await linkSellerToCore(seller, coreUrl);
    }
    applied.push(`${m.tag} (${m.target})`);
    log(`applied ${m.tag} → ${m.target}`);
  }
  const repaired = await reconcile({ core, seller, coreUrl, log });
  return { applied, repaired };
}

/**
 * Brings both sides' foreign tables, the seller identity columns and the seller
 * functions' search path back in line with the tables themselves. Each step
 * looks first and only changes what is out of line, so it is cheap on every
 * build and finishes the work of a run that stopped half way.
 *
 * @param {{ core: import("postgres").Sql, seller: import("postgres").Sql, coreUrl: string, log?: (line: string) => void }} options
 * @returns {Promise<string[]>}
 */
export async function reconcile({ core, seller, coreUrl, log = () => {} }) {
  const repaired = [];
  const ids = await acceptCoreIds(seller);
  if (ids) repaired.push(`${ids} seller identity column(s) accept core ids`);
  const pinned = await pinFunctionSearchPath(seller);
  if (pinned) repaired.push(`${pinned} seller function(s) given the site's search path`);
  const sellerTables = await baseTables(seller);
  if ((await columnsOf(core, sellerTables)) !== (await columnsOf(seller, sellerTables))) {
    await core.begin((tx) => refreshForeignTables(tx, seller));
    repaired.push("core foreign tables re-imported");
  }
  if ((await columnsOf(seller, SELLER_LINKED_CORE_TABLES)) !== (await columnsOf(core, SELLER_LINKED_CORE_TABLES))) {
    await linkSellerToCore(seller, coreUrl);
    repaired.push("seller links to the core re-imported");
  }
  for (const line of repaired) log(`repaired: ${line}`);
  return repaired;
}

async function baseTables(sql) {
  return sql`
    select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'pmd') and c.relkind in ('r', 'p') and not c.relispartition order by 1, 2`;
}

/** Column names and types of the given tables (schema + name, or a name in public), as one comparable string. */
async function columnsOf(sql, tables) {
  const keys = tables.map((t) => (typeof t === "string" ? `public.${t}` : `${t.schema}.${t.name}`));
  const rows = await sql`
    select table_schema || '.' || table_name as t, column_name as c, data_type as d from information_schema.columns
    where table_schema || '.' || table_name = any(${keys}) order by 1, 2`;
  return rows.map((r) => `${r.t}.${r.c}:${r.d}`).join("\n");
}

/** Seller identity columns accept the ids the core draws (GENERATED ALWAYS → BY DEFAULT). */
export async function acceptCoreIds(seller) {
  const rows = await seller`
    select table_schema as schema, table_name as table, column_name as column from information_schema.columns
    where is_identity = 'YES' and identity_generation = 'ALWAYS' and table_schema in ('public', 'pmd')`;
  for (const r of rows) await seller.unsafe(`alter table ${ident(r.schema)}.${ident(r.table)} alter column ${ident(r.column)} set generated by default`);
  return rows.length;
}

/** postgres_fdw sessions use search_path = pg_catalog; seller functions get the site's own path. */
export async function pinFunctionSearchPath(seller) {
  const rows = await seller`
    select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'pmd') and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and not coalesce(p.proconfig, '{}') @> array['search_path="$user", public']`;
  for (const r of rows) await seller.unsafe(`alter function ${r.signature} set search_path = "$user", public`);
  return rows.length;
}

/**
 * Re-imports every seller table into the core as a foreign table (inside the
 * caller's core transaction), so new tables and columns appear. Sequences the
 * seller defaults use are created in the core when missing (the core draws all
 * ids); identity columns get a core-drawn default.
 */
export async function refreshForeignTables(coreTx, seller) {
  const tables = await baseTables(seller);
  const seqs = await seller`
    select s.oid::regclass::text as sequence, n.nspname as schema, t.relname as table, a.attname as column, d.deptype = 'i' as identity
    from pg_depend d
    join pg_class s on s.oid = d.objid and s.relkind = 'S'
    join pg_class t on t.oid = d.refobjid join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where d.deptype in ('a', 'i') and n.nspname in ('public', 'pmd')
    union
    select s.oid::regclass::text, n.nspname, t.relname, a.attname, false
    from pg_attrdef ad
    join pg_depend d on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid and d.refclassid = 'pg_class'::regclass
    join pg_class s on s.oid = d.refobjid and s.relkind = 'S'
    join pg_class t on t.oid = ad.adrelid join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = ad.adnum
    where n.nspname in ('public', 'pmd')`;
  for (const s of seqs) {
    const qualified = s.sequence.includes(".") ? s.sequence : `public.${s.sequence}`;
    const [{ exists }] = await coreTx`select to_regclass(${qualified}) is not null as exists`;
    if (exists) continue;
    const [{ v }] = await seller.unsafe(`select last_value as v from ${qualified.split(".").map((p) => ident(p.replace(/"/g, ""))).join(".")}`);
    await coreTx.unsafe(`create sequence if not exists ${qualified.split(".").map((p) => ident(p.replace(/"/g, ""))).join(".")}`);
    await coreTx.unsafe(`select setval(${literal(qualified)}, ${v}, true)`);
  }
  for (const schema of ["public", "pmd"]) {
    const names = tables.filter((t) => t.schema === schema).map((t) => t.name);
    if (names.length === 0) continue;
    const local = await coreTx`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relkind in ('r', 'p') and c.relname = any(${names})`;
    if (local.length) throw new Error(`The core has its own copy of seller table(s) ${local.map((l) => `${schema}.${l.name}`).join(", ")}; a seller migration ran in the wrong database.`);
    await coreTx.unsafe(`create schema if not exists ${ident(schema)}`);
    for (const name of names) await coreTx.unsafe(`drop foreign table if exists ${ident(schema)}.${ident(name)} cascade`);
    await coreTx.unsafe(
      `import foreign schema ${ident(schema)} limit to (${names.map(ident).join(", ")}) from server ${ident(SELLER_SERVER)} into ${ident(schema)} options (import_default 'true')`,
    );
  }
  for (const s of seqs.filter((x) => x.identity)) {
    const qualified = s.sequence.includes(".") ? s.sequence : `public.${s.sequence}`;
    await coreTx.unsafe(`alter foreign table ${ident(s.schema)}.${ident(s.table)} alter column ${ident(s.column)} set default nextval(${literal(qualified)})`);
  }
}

/** The seller database's foreign tables for the core tables it uses, imported again. */
export async function linkSellerToCore(seller, coreUrl) {
  const options = fdwOptions(coreUrl);
  await seller.begin(async (tx) => {
    await tx.unsafe(`create extension if not exists postgres_fdw`);
    const existing = await tx`
      select c.relname as name, c.relkind::text as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${SELLER_LINKED_CORE_TABLES})`;
    for (const t of existing) await tx.unsafe(`drop ${t.kind === "f" ? "foreign table" : "table"} ${ident(t.name)} cascade`);
    await tx.unsafe(`drop server if exists ${ident(CORE_SERVER)} cascade`);
    await tx.unsafe(`create server ${ident(CORE_SERVER)} foreign data wrapper postgres_fdw options (${options.server})`);
    await tx.unsafe(`create user mapping for current_user server ${ident(CORE_SERVER)} options (${options.user})`);
    await tx.unsafe(
      `import foreign schema public limit to (${SELLER_LINKED_CORE_TABLES.map(ident).join(", ")}) from server ${ident(CORE_SERVER)} into public options (import_default 'true')`,
    );
  });
}
