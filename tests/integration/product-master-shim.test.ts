/**
 * The postgres.js-shaped shim over mysql2 (src/server/pmd/mysql/sql.ts).
 *
 * These cover the surface the PMD survey found in use, and in particular the
 * laziness that fragment nesting depends on: a template must not execute until
 * something awaits it, or `${cond ? sql`…` : sql``}` cannot work.
 *
 * Deliberately NOT named pmd-*.test.ts: `npm run test:ci` excludes that pattern
 * because the rest of PMD still needs a PostgreSQL server, and this file does
 * not — it tests the MySQL shim and nothing else, so it runs in CI.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSql, type PmdSql } from "@/server/pmd/mysql/sql";

const url = process.env.PMD_TEST_MYSQL_URL;
const describeIf = url ? describe : describe.skip;

describeIf("the PMD mysql2 shim", () => {
  let sql: PmdSql;

  beforeAll(async () => {
    sql = createSql(url!, { max: 3, applicationName: "shim-test" });
    await sql`DROP TABLE IF EXISTS shim_t`;
    await sql`CREATE TABLE shim_t (
      id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name varchar(64) NOT NULL,
      score decimal(5,2),
      day date,
      big bigint,
      flag boolean,
      doc json
    )`;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DROP TABLE IF EXISTS shim_t`;
      await sql.end();
    }
  });

  it("parameterises interpolations rather than inlining them", async () => {
    await sql`INSERT INTO shim_t (name) VALUES (${"o'brien"})`;
    const rows = await sql<{ name: string }>`SELECT name FROM shim_t WHERE name = ${"o'brien"}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("o'brien");
  });

  it("does not execute a template until it is awaited", async () => {
    const before = await sql<{ n: number }>`SELECT count(*) AS n FROM shim_t`;
    // built but never awaited
    const unused = sql`INSERT INTO shim_t (name) VALUES (${"never"})`;
    const after = await sql<{ n: number }>`SELECT count(*) AS n FROM shim_t`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(unused).toBeDefined();
  });

  it("splices a nested fragment, keeping parameter order", async () => {
    await sql`INSERT INTO shim_t (name, score) VALUES (${"a"}, ${10}), (${"b"}, ${20})`;
    const only = (min: number | null) => (min === null ? sql`` : sql`AND score >= ${min}`);
    const rows = await sql<{ name: string }>`
      SELECT name FROM shim_t WHERE name IN (${"a"}, ${"b"}) ${only(15)} ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(["b"]);
    const all = await sql<{ name: string }>`
      SELECT name FROM shim_t WHERE name IN (${"a"}, ${"b"}) ${only(null)} ORDER BY name`;
    expect(all.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("expands sql(array) for IN, including the empty case", async () => {
    const rows = await sql<{ name: string }>`
      SELECT name FROM shim_t WHERE name IN ${sql(["a", "b"])} ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
    const none = await sql`SELECT name FROM shim_t WHERE name IN ${sql([])}`;
    expect(none).toHaveLength(0);
  });

  it("sends sql.json() as JSON and reads it back", async () => {
    await sql`INSERT INTO shim_t (name, doc) VALUES (${"j"}, ${sql.json({ a: [1, 2], b: "x" })})`;
    const [row] = await sql<{ doc: unknown }>`SELECT doc FROM shim_t WHERE name = ${"j"}`;
    expect(row!.doc).toEqual({ a: [1, 2], b: "x" });
  });

  it("coerces the three types db.ts pinned on postgres.js", async () => {
    await sql`INSERT INTO shim_t (name, score, day, big, flag)
              VALUES (${"t"}, ${12.5}, ${"2026-03-01"}, ${9007199254740991}, ${true})`;
    const [row] = await sql<{ score: unknown; day: unknown; big: unknown; flag: unknown }>`
      SELECT score, day, big, flag FROM shim_t WHERE name = ${"t"}`;
    expect(row!.score).toBe(12.5);          // decimal -> number
    expect(row!.day).toBe("2026-03-01");    // date -> 'YYYY-MM-DD' string, never a Date
    expect(row!.big).toBe(9007199254740991); // bigint -> number
    expect(row!.flag).toBe(true);            // tinyint(1) -> boolean
  });

  it("commits a transaction and rolls one back", async () => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO shim_t (name) VALUES (${"committed"})`;
    });
    expect(await sql`SELECT 1 FROM shim_t WHERE name = ${"committed"}`).toHaveLength(1);

    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO shim_t (name) VALUES (${"rolled-back"})`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await sql`SELECT 1 FROM shim_t WHERE name = ${"rolled-back"}`).toHaveLength(0);
  });

  it("accepts sql.begin('read only', fn) and refuses a write inside it", async () => {
    const rows = await sql.begin("read only", async (tx) => tx<{ n: number }>`SELECT count(*) AS n FROM shim_t`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    await expect(
      sql.begin("read only", async (tx) => tx`INSERT INTO shim_t (name) VALUES (${"nope"})`),
    ).rejects.toThrow();
  });

  it("runs literal text through sql.unsafe", async () => {
    const rows = await sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM shim_t WHERE name = ?", ["a"]);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
