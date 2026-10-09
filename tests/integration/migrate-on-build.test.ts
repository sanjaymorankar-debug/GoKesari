/**
 * scripts/migrate-on-build.mjs — the first step of `npm run build`.
 *
 * Off unless MIGRATE_ON_BUILD=true (the build is then exactly as before). On,
 * it applies pending migrations; any failure exits non-zero so `next build`
 * never runs, and drizzle's single transaction leaves the database as it was.
 *
 * Runs the real script in a child process against a throwaway database, with a
 * clean environment so a developer's own variables cannot leak in.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { tag: string; when: number }[];
};
const whenOf = (prefix: string) => journal.entries.find((e) => e.tag.startsWith(prefix))!.when;

const baseUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `migrate_on_build_${process.pid}_${Date.now()}`;
const tempUrl = new URL(baseUrl);
tempUrl.pathname = `/${dbName}`;

const admin = postgres(baseUrl.toString(), { max: 1, onnotice: () => {} });
let created = false;

function runScript(env: { MIGRATE_ON_BUILD: string; DATABASE_URL: string }) {
  const res = spawnSync(process.execPath, ["scripts/migrate-on-build.mjs"], {
    cwd: process.cwd(),
    // NODE_ENV as on the host, where the build runs in production mode.
    env: { PATH: process.env.PATH, NODE_ENV: "production", ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** The same as runScript, without blocking — to start two migrations at once. */
function runScriptAsync(env: { MIGRATE_ON_BUILD: string; DATABASE_URL: string }) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["scripts/migrate-on-build.mjs"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "production", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function withTemp<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(tempUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const journalCount = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
    if (!t) return 0;
    const [{ n }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return n as number;
  });

const kycTableExists = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('public.delivery_partner_documents')::text as t`;
    return t !== null;
  });

const shopMediaExists = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('public.stored_image_variants')::text as t`;
    return t !== null;
  });

const integrationsExist = () =>
  withTemp(async (sql) => {
    const [{ a, b }] = await sql`select to_regclass('public.integration_jobs')::text as a, to_regclass('public.credit_notes')::text as b`;
    return a !== null && b !== null;
  });

const selfRegistrationExists = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('public.shop_registrations')::text as t`;
    return t !== null;
  });

const shopWalletExists = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('public.shop_wallets')::text as t`;
    return t !== null;
  });

const eventLayerExists = () =>
  withTemp(async (sql) => {
    const [{ t }] = await sql`select to_regclass('public.domain_events')::text as t`;
    return t !== null;
  });

/** Migrations newer than 0055 in this checkout (0056 onwards). */
const after0055 = () => journal.entries.filter((e) => e.when > whenOf("0055_")).length;

/** Puts the database back on 0055 with the releases' own rollback scripts. */
const backToMigration0055 = () =>
  withTemp(async (sql) => {
    // docs/four-features-2026-10 (0073, bank account checks; 0072, customer referral requests), docs/three-modules-2026-10 (0068–0071),
    // then docs/four-features-2026-10 (0061–0067), newest first.
    for (const n of ["0073", "0072", "0071", "0070", "0069", "0068", "0067", "0066", "0065", "0064", "0063", "0062", "0061"]) await sql.unsafe(readFileSync(`scripts/rollback-${n}.sql`, "utf8"));
    await sql.unsafe(readFileSync("scripts/rollback-0060.sql", "utf8"));
    await sql.unsafe(readFileSync("scripts/rollback-0059.sql", "utf8"));
    await sql.unsafe(readFileSync("scripts/rollback-0058.sql", "utf8"));
    await sql.unsafe(readFileSync("scripts/rollback-0057.sql", "utf8"));
    await sql.unsafe(readFileSync("scripts/rollback-0056.sql", "utf8"));
    await sql`delete from drizzle.__drizzle_migrations where created_at >= ${whenOf("0056_")}`;
  });

beforeAll(async () => {
  try {
    await admin.unsafe(`create database "${dbName}"`);
    created = true;
  } catch (err) {
    // A database role without CREATEDB cannot run this file; say so plainly.
    console.warn(`migrate-on-build: cannot create a scratch database (${String(err)})`);
  }
});

afterAll(async () => {
  if (created) await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.end();
});

describe("migrate-on-build", () => {
  it("does nothing unless MIGRATE_ON_BUILD is true", async (ctx) => {
    if (!created) ctx.skip();
    for (const value of ["", "false", "yes please"]) {
      const res = runScript({ MIGRATE_ON_BUILD: value, DATABASE_URL: tempUrl.toString() });
      expect(res.code).toBe(0);
      expect(res.out).toContain("[migrate-on-build] skipped");
    }
    expect(await journalCount()).toBe(0);
  });

  it("stops the build when switched on without a DATABASE_URL", () => {
    const res = runScript({ MIGRATE_ON_BUILD: "true", DATABASE_URL: "" });
    expect(res.code).toBe(1);
    expect(res.out).toContain("DATABASE_URL is not set");
  });

  it("migrates an empty database, then is a no-op on the next build", async (ctx) => {
    if (!created) ctx.skip();
    const first = runScript({ MIGRATE_ON_BUILD: "true", DATABASE_URL: tempUrl.toString() });
    expect(first.code).toBe(0);
    expect(first.out).toContain(`applied ${journal.entries.length} new migration(s)`);
    if (tempUrl.password) expect(first.out).not.toContain(tempUrl.password);
    expect(await journalCount()).toBe(journal.entries.length);

    const second = runScript({ MIGRATE_ON_BUILD: "true", DATABASE_URL: tempUrl.toString() });
    expect(second.code).toBe(0);
    expect(second.out).toContain("applied 0 new migration(s)");
  });

  it("two migrations started at once (the deploy build and the test-db workflow) both succeed, applying each migration once", async (ctx) => {
    if (!created) ctx.skip();
    await withTemp((sql) => sql.unsafe("drop schema if exists drizzle cascade; drop schema if exists pmd cascade; drop schema public cascade; create schema public;"));
    const env = { MIGRATE_ON_BUILD: "true", DATABASE_URL: tempUrl.toString() };
    const [a, b] = await Promise.all([runScriptAsync(env), runScriptAsync(env)]);
    expect([a.code, b.code], `${a.out}\n---\n${b.out}`).toEqual([0, 0]);
    // One of them applied everything; the other waited for it and found nothing to do.
    const applied = [a.out, b.out].map((o) => Number(/applied (\d+) new migration/.exec(o)?.[1]));
    expect(applied.sort((x, y) => x - y)).toEqual([0, journal.entries.length]);
    expect(await journalCount()).toBe(journal.entries.length);
  });

  it("brings a database on 0055 up to date: 0056, 0057, 0058, 0059, 0060 and every later migration", async (ctx) => {
    if (!created) ctx.skip();
    await backToMigration0055();
    const before = await journalCount();
    expect(await kycTableExists()).toBe(false);
    expect(await eventLayerExists()).toBe(false);
    expect(await shopWalletExists()).toBe(false);
    expect(await shopMediaExists()).toBe(false);
    expect(await integrationsExist()).toBe(false);
    expect(await selfRegistrationExists()).toBe(false);

    const res = runScript({ MIGRATE_ON_BUILD: "1", DATABASE_URL: tempUrl.toString() });
    expect(res.code).toBe(0);
    expect(res.out).toContain(`applied ${after0055()} new migration(s)`);
    expect(res.out).toContain(`newest ${journal.entries.at(-1)!.when}`);
    expect(await journalCount()).toBe(before + after0055());
    expect(await integrationsExist()).toBe(true);
    expect(await selfRegistrationExists()).toBe(true);
    expect(await kycTableExists()).toBe(true);
    expect(await eventLayerExists()).toBe(true);
    expect(await shopWalletExists()).toBe(true);
    expect(await shopMediaExists()).toBe(true);
    const cols = await withTemp(
      (sql) => sql`select column_name from information_schema.columns
                   where table_name = 'shops' and column_name in ('contact_phone', 'whatsapp_number')`,
    );
    expect(cols).toHaveLength(2);
    // 0060 in the same transaction as 0059: the enum value it adds is usable once committed.
    const [refund] = await withTemp(
      (sql) => sql`select 'COMMISSION_REFUND'::shop_wallet_entry_type::text as v,
                          to_regclass('public.order_financials') is not null as t,
                          exists (select 1 from information_schema.columns
                                  where table_name = 'order_financials' and column_name = 'shop_delivery_distance_m') as c`,
    );
    expect(refund).toEqual({ v: "COMMISSION_REFUND", t: true, c: true });
  });

  it("a failed migration stops the build and leaves the database as it was", async (ctx) => {
    if (!created) ctx.skip();
    await backToMigration0055();
    // 0056 adds shops.contact_phone without IF NOT EXISTS, so this makes it fail.
    await withTemp((sql) => sql`alter table shops add column contact_phone text`);
    const before = await journalCount();

    const res = runScript({ MIGRATE_ON_BUILD: "true", DATABASE_URL: tempUrl.toString() });
    expect(res.code).toBe(1);
    expect(res.out).toContain("[migrate-on-build] FAILED");
    expect(res.out).toContain("Build stopped");
    // One transaction: none of 0056 onwards was recorded or applied.
    expect(await journalCount()).toBe(before);
    expect(await kycTableExists()).toBe(false);
    expect(await eventLayerExists()).toBe(false);
    expect(await shopWalletExists()).toBe(false);
    expect(await shopMediaExists()).toBe(false);
    expect(await integrationsExist()).toBe(false);
    expect(await selfRegistrationExists()).toBe(false);
  });
});
