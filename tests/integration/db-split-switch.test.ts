/**
 * Switching a site's database to the split layout and back
 * (src/server/db/split/switch.ts): a seeded single database is switched, used
 * through the core, switched back with every row written meanwhile, and
 * switched again. Runs on its own temporary databases.
 */
import { execFileSync } from "node:child_process";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { checkSwitch, checkSwitchBack, dropParked, switchBack, switchToSplit } from "@/server/db/split/switch";
import { connect, fingerprint, type Sql } from "@/server/db/split/tools";
import { goesToSellerDatabase } from "@/server/pmd/db";
import { isSplitLayout, reconcile } from "../../scripts/split-migrate.mjs";

const baseUrl = process.env.TEST_DATABASE_URL!;
const suffix = `${process.pid}_${Date.now() % 100000}`;
const coreName = `gk_switch_core_${suffix}`;
const sellerName = `gk_switch_seller_${suffix}`;
const urlFor = (name: string) => {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const coreUrl = urlFor(coreName);
const sellerUrl = urlFor(sellerName);

let admin: Sql;
let core: Sql;
let seller: Sql;
const quiet = () => undefined;

async function kind(sql: Sql, table: string): Promise<string | null> {
  const [row] = await sql<{ kind: string }[]>`select c.relkind::text as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = ${table}`;
  return row?.kind ?? null;
}

beforeAll(async () => {
  admin = connect(urlFor("postgres"), 1);
  await admin.unsafe(`create database "${coreName}"`);
  await admin.unsafe(`create database "${sellerName}"`);
  core = connect(coreUrl, 3);
  seller = connect(sellerUrl, 3);
  await migrate(drizzle(core), { migrationsFolder: "./drizzle" });
  // Demo marketplace: users, shops, catalogue, wallets.
  execFileSync("npx", ["tsx", "src/server/db/seed.ts"], { env: { ...process.env, DATABASE_URL: coreUrl, DB_SPLIT_MODE: "single" }, stdio: "pipe" });
}, 300_000);

afterAll(async () => {
  await core?.end();
  await seller?.end();
  if (admin) {
    await admin.unsafe(`drop database if exists "${coreName}" with (force)`);
    await admin.unsafe(`drop database if exists "${sellerName}" with (force)`);
    await admin.end();
  }
});

describe("switching a site's database to the split layout and back", { timeout: 300_000 }, () => {
  let shopsBefore: Awaited<ReturnType<typeof fingerprint>>;
  let shopId: string;
  let markId: string;
  let drawn: number;

  it("checks first: the same database twice and an unreachable seller database are refused, the real pair is ready", async () => {
    const same = await checkSwitch(core, core, { core: coreUrl, seller: coreUrl });
    expect(same.ready).toBe(false);
    expect(same.problems.join(" ")).toMatch(/same database/);
    // The link is tried for real (and rolled back): a seller database the core cannot reach is caught here.
    const unreachable = await checkSwitch(core, seller, { core: coreUrl, seller: urlFor("gk_no_such_database") });
    expect(unreachable.problems.join(" ")).toMatch(/core cannot reach the seller database through postgres_fdw/);
    expect((await core<{ n: number }[]>`select count(*)::int as n from pg_foreign_server`)[0].n).toBe(0);
    const check = await checkSwitch(core, seller, { core: coreUrl, seller: sellerUrl });
    expect(check.problems).toEqual([]);
    expect(check.notes.join(" ")).toMatch(/seller tables \(\d+ rows\) move/);
  });

  it("switches: seller rows move to the seller database, the core reads and writes them through foreign tables", async () => {
    // Before the switch the setting changes nothing: the product master stays on the site's database.
    expect(await goesToSellerDatabase(core, { DATABASE_URL: coreUrl, DB_SPLIT_MODE: "split", SELLER_DATABASE_URL: sellerUrl }, { cached: false })).toBe(false);
    shopsBefore = await fingerprint(core, "shops");
    expect(shopsBefore.rows).toBeGreaterThan(0);
    const result = await switchToSplit({ core, seller, coreUrl, sellerUrl, log: quiet });
    expect(result.tables).toBeGreaterThan(100);

    expect(await isSplitLayout(core)).toBe(true);
    expect(await kind(core, "shops")).toBe("f");
    expect(await kind(core, "users")).toBe("r");
    expect(await kind(seller, "shops")).toBe("r");
    expect(await kind(seller, "users")).toBe("f");
    expect(await fingerprint(seller, "shops")).toEqual(shopsBefore);
    // The core's own copy is parked, not dropped.
    const [{ parked }] = await core<{ parked: number }[]>`select count(*)::int as parked from pg_tables where schemaname in ('split_parked', 'split_parked_pmd')`;
    expect(parked).toBeGreaterThan(100);

    // Written through the core, it lands in the seller database.
    [{ id: shopId }] = await core<{ id: string }[]>`select id from shops order by created_at limit 1`;
    await core`update shops set name = 'Renamed after the switch' where id = ${shopId}`;
    const [{ name }] = await seller<{ name: string }[]>`select name from shops where id = ${shopId}`;
    expect(name).toBe("Renamed after the switch");
    // Ids are drawn in the core; the seller's trigger still runs on the row.
    [{ id: markId }] = await core<{ id: string }[]>`insert into inv_ledger_marks default values returning id`;
    const [{ xact }] = await seller<{ xact: string | null }[]>`select xact::text as xact from inv_ledger_marks where id = ${markId}`;
    expect(xact).not.toBeNull();
    // An identity column of a seller table draws from a sequence in the core.
    [{ drawn }] = await core<{ drawn: number }[]>`select nextval('shop_wallet_transactions_seq_seq')::int as drawn`;
    expect(await reconcile({ core, seller, coreUrl })).toEqual([]);

    // The product master goes to the seller database directly — only to the one the switch filled.
    const env = { DATABASE_URL: coreUrl, DB_SPLIT_MODE: "split" };
    const fresh = { cached: false };
    expect(await goesToSellerDatabase(core, { ...env, SELLER_DATABASE_URL: sellerUrl }, fresh)).toBe(true);
    expect(await goesToSellerDatabase(core, { ...env, DB_SPLIT_MODE: "single", SELLER_DATABASE_URL: sellerUrl }, fresh)).toBe(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await goesToSellerDatabase(core, { ...env, SELLER_DATABASE_URL: urlFor("some_other_seller_db") }, fresh)).toBe(false);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/SELLER_DATABASE_URL is some_other_seller_db on .* but this site's seller tables are in gk_switch_seller_/);
    } finally {
      error.mockRestore();
    }
  });

  it("refuses a second switch", async () => {
    const check = await checkSwitch(core, seller, { core: coreUrl, seller: sellerUrl });
    expect(check.problems.join(" ")).toMatch(/already on the split layout/);
  });

  it("switches back with every row written since, and the foreign keys", async () => {
    expect((await checkSwitchBack(core, seller)).problems).toEqual([]);
    const shopsNow = await fingerprint(seller, "shops");
    const result = await switchBack({ core, seller, log: quiet });
    expect(result.orphanedForeignKeys).toEqual([]);

    expect(await isSplitLayout(core)).toBe(false);
    expect(await kind(core, "shops")).toBe("r");
    expect(await fingerprint(core, "shops")).toEqual(shopsNow);
    const [{ name }] = await core<{ name: string }[]>`select name from shops where id = ${shopId}`;
    expect(name).toBe("Renamed after the switch");
    // Cross-database foreign keys are back and enforced (shops → users).
    const [{ fks }] = await core<{ fks: number }[]>`
      select count(*)::int as fks from pg_constraint where contype = 'f' and conrelid = 'public.shops'::regclass and confrelid = 'public.users'::regclass and convalidated`;
    expect(fks).toBeGreaterThan(0);
    const [{ left }] = await core<{ left: number }[]>`select count(*)::int as "left" from pg_namespace where nspname like 'split_parked%'`;
    expect(left).toBe(0);
    const [{ servers }] = await core<{ servers: number }[]>`select count(*)::int as servers from pg_foreign_server`;
    expect(servers).toBe(0);
    // Ids keep counting from where the split left them.
    const [{ next }] = await core<{ next: number }[]>`select nextval(pg_get_serial_sequence('shop_wallet_transactions', 'seq'))::int as next`;
    expect(next).toBeGreaterThan(drawn);
    expect((await core<{ n: number }[]>`select count(*)::int as n from inv_ledger_marks where id = ${markId}`)[0].n).toBe(1);
    expect((await checkSwitchBack(core, seller)).ready).toBe(false);
  });

  it("can switch again while the site keeps writing — no write is lost — and frees the parked copy on request", async () => {
    // Two writers keep renaming shops, one statement at a time, during the whole switch: one with
    // prepared statements (cached plans), one without (the site's setting, DATABASE_PREPARED_STATEMENTS=off).
    const shopIds = (await core<{ id: string }[]>`select id from shops order by created_at limit 2`).map((r) => r.id);
    const writers = [connect(coreUrl, 1), postgres(coreUrl, { max: 1, prepare: false, onnotice: () => undefined })];
    // Each write adds one to a counter, so a write that waited for the switch and then went to the
    // parked copy instead of the seller database would leave the total short.
    const start = await Promise.all(shopIds.map(async (id) => (await core<{ n: number }[]>`select rating_count as n from shops where id = ${id}`)[0].n));
    let done = false;
    const last = [0, 0];
    const longestWait = [0, 0];
    const writing = writers.map(async (w, k) => {
      // Until the switch is over, then a few writes more.
      for (let i = 1, after = 0; !done || after++ < 3; i++) {
        const t0 = Date.now();
        await w`update shops set rating_count = rating_count + 1 where id = ${shopIds[k]}`;
        longestWait[k] = Math.max(longestWait[k], Date.now() - t0);
        last[k] = i;
      }
    });
    try {
      await switchToSplit({ core, seller, coreUrl, sellerUrl, log: quiet });
    } finally {
      done = true;
      await Promise.all(writing);
      await Promise.all(writers.map((w) => w.end()));
    }
    for (const k of [0, 1]) {
      // Some write waited for the switch (writes pause while the rows are copied)…
      expect(longestWait[k]).toBeGreaterThan(500);
      // …and none was lost.
      const [{ n }] = await seller<{ n: number }[]>`select rating_count as n from shops where id = ${shopIds[k]}`;
      expect(n).toBe(start[k] + last[k]);
    }
    expect(await isSplitLayout(core)).toBe(true);
    expect(await dropParked(core)).toEqual(["split_parked", "split_parked_pmd"]);
    expect((await checkSwitchBack(core, seller)).problems.join(" ")).toMatch(/no parked copy/);
  });
});
