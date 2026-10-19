/**
 * Migrations on the seller / customer split layout (scripts/split-migrate.mjs,
 * docs/db-split-2026-10/CODE_SPLIT_PLAN.md): a seller migration runs in the
 * seller database and the core sees its new table and column through the
 * foreign tables; a core migration runs in the core and the seller database's
 * link to it is refreshed; an untagged migration is refused; a second run
 * applies nothing.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyOverlay, buildOverlayPlan, linkSellerToCore } from "@/server/db/split/overlay";
import { connect, prepareTarget, type Sql } from "@/server/db/split/tools";
import { migrateSplit } from "../../scripts/split-migrate.mjs";

const baseUrl = process.env.TEST_DATABASE_URL!;
const suffix = `${process.pid}_${Date.now() % 100000}`;
const coreName = `gk_mig_core_${suffix}`;
const sellerName = `gk_mig_seller_${suffix}`;
const urlFor = (name: string) => {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

let admin: Sql;
let core: Sql;
let seller: Sql;
let folder: string;

function addMigration(tag: string, sql: string) {
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries[journal.entries.length - 1];
  journal.entries.push({ idx: last.idx + 1, version: "7", when: last.when + 60_000, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(path.join(folder, `${tag}.sql`), sql);
}

beforeAll(async () => {
  admin = connect(urlFor("postgres"), 1);
  await admin.unsafe(`create database "${coreName}"`);
  await admin.unsafe(`create database "${sellerName}"`);
  core = connect(urlFor(coreName), 2);
  seller = connect(urlFor(sellerName), 2);
  await migrate(drizzle(core), { migrationsFolder: "./drizzle" });
  await prepareTarget(seller, "seller");
  await applyOverlay(core, urlFor(sellerName), await buildOverlayPlan(core), () => undefined, seller);
  await linkSellerToCore(seller, urlFor(coreName));
  folder = mkdtempSync(path.join(tmpdir(), "gk-migrations-"));
  cpSync("./drizzle", folder, { recursive: true });
}, 300_000);

afterAll(async () => {
  await core?.end();
  await seller?.end();
  if (admin) {
    await admin.unsafe(`drop database if exists "${coreName}" with (force)`);
    await admin.unsafe(`drop database if exists "${sellerName}" with (force)`);
    await admin.end();
  }
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe("migrations on the split layout", { timeout: 300_000 }, () => {
  it("runs each migration where its tables live and refreshes both sides' foreign tables", async () => {
    addMigration(
      "9001_test_seller",
      `-- split: seller
CREATE TABLE "test_shop_notes" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "shop_id" uuid NOT NULL, "seq" bigint GENERATED ALWAYS AS IDENTITY, "note" text NOT NULL);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "test_flag" boolean DEFAULT false NOT NULL;`,
    );
    addMigration("9002_test_core", `-- split: core\nALTER TABLE "orders" ADD COLUMN "test_note" text;`);

    const { applied } = await migrateSplit({ core, seller, coreUrl: urlFor(coreName), folder });
    expect(applied).toEqual(["9001_test_seller (seller)", "9002_test_core (core)"]);

    // The new seller table: in the seller database, reached from the core; the core draws its identity ids.
    const [{ kind }] = await core<{ kind: string }[]>`select c.relkind::text as kind from pg_class c where c.relname = 'test_shop_notes'`;
    expect(kind).toBe("f");
    await core`insert into test_shop_notes (shop_id, note) values (gen_random_uuid(), 'hello')`;
    const [{ n, seq }] = await seller<{ n: number; seq: number }[]>`select count(*)::int as n, max(seq)::int as seq from test_shop_notes`;
    expect(n).toBe(1);
    expect(seq).toBeGreaterThan(0);
    // The new column on a seller table is visible in the core.
    const [{ cols }] = await core<{ cols: number }[]>`select count(*)::int as cols from information_schema.columns where table_name = 'shops' and column_name = 'test_flag'`;
    expect(cols).toBe(1);
    // The core migration ran in the core only, and the seller database's link to orders sees the new column.
    const [{ local }] = await core<{ local: number }[]>`select count(*)::int as local from information_schema.columns where table_name = 'orders' and column_name = 'test_note'`;
    expect(local).toBe(1);
    const [{ linked }] = await seller<{ linked: number }[]>`select count(*)::int as linked from information_schema.columns where table_name = 'orders' and column_name = 'test_note'`;
    expect(linked).toBe(1);
    // Both databases recorded both migrations.
    const [{ c }] = await core<{ c: number }[]>`select count(*)::int as c from drizzle.__drizzle_migrations`;
    const [{ s }] = await seller<{ s: number }[]>`select count(*)::int as s from drizzle.__drizzle_migrations`;
    expect(c).toBe(s);
  });

  it("applies and repairs nothing on a second run", async () => {
    expect(await migrateSplit({ core, seller, coreUrl: urlFor(coreName), folder })).toEqual({ applied: [], repaired: [] });
  });

  it("finishes the work of a run that stopped half way", async () => {
    // As if a run stopped after the seller side committed: a new seller column the core cannot see yet, and a stale link to orders.
    await seller`alter table shops add column test_late text`;
    await core`alter table orders add column test_late text`;
    const { applied, repaired } = await migrateSplit({ core, seller, coreUrl: urlFor(coreName), folder });
    expect(applied).toEqual([]);
    expect(repaired).toEqual(["core foreign tables re-imported", "seller links to the core re-imported"]);
    const [{ coreSees }] = await core<{ coreSees: number }[]>`select count(*)::int as "coreSees" from information_schema.columns where table_name = 'shops' and column_name = 'test_late'`;
    const [{ sellerSees }] = await seller<{ sellerSees: number }[]>`select count(*)::int as "sellerSees" from information_schema.columns where table_name = 'orders' and column_name = 'test_late'`;
    expect([coreSees, sellerSees]).toEqual([1, 1]);
  });

  it("refuses a migration that does not say where it runs", async () => {
    addMigration("9003_untagged", `ALTER TABLE "orders" ADD COLUMN "untagged" text;`);
    await expect(migrateSplit({ core, seller, coreUrl: urlFor(coreName), folder })).rejects.toThrow(/must say where it runs/);
  });
});
