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
    const rows = await sql<{ name: string }[]>`SELECT name FROM shim_t WHERE name = ${"o'brien"}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("o'brien");
  });

  it("does not execute a template until it is awaited", async () => {
    const before = await sql<{ n: number }[]>`SELECT count(*) AS n FROM shim_t`;
    // built but never awaited
    const unused = sql`INSERT INTO shim_t (name) VALUES (${"never"})`;
    const after = await sql<{ n: number }[]>`SELECT count(*) AS n FROM shim_t`;
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(unused).toBeDefined();
  });

  it("splices a nested fragment, keeping parameter order", async () => {
    await sql`INSERT INTO shim_t (name, score) VALUES (${"a"}, ${10}), (${"b"}, ${20})`;
    const only = (min: number | null) => (min === null ? sql`` : sql`AND score >= ${min}`);
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM shim_t WHERE name IN (${"a"}, ${"b"}) ${only(15)} ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(["b"]);
    const all = await sql<{ name: string }[]>`
      SELECT name FROM shim_t WHERE name IN (${"a"}, ${"b"}) ${only(null)} ORDER BY name`;
    expect(all.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("expands sql(array) for IN, including the empty case", async () => {
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM shim_t WHERE name IN ${sql(["a", "b"])} ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
    const none = await sql`SELECT name FROM shim_t WHERE name IN ${sql([])}`;
    expect(none).toHaveLength(0);
  });

  it("sends sql.json() as JSON and reads it back", async () => {
    await sql`INSERT INTO shim_t (name, doc) VALUES (${"j"}, ${sql.json({ a: [1, 2], b: "x" })})`;
    const [row] = await sql<{ doc: unknown }[]>`SELECT doc FROM shim_t WHERE name = ${"j"}`;
    expect(row!.doc).toEqual({ a: [1, 2], b: "x" });
  });

  it("coerces the three types db.ts pinned on postgres.js", async () => {
    await sql`INSERT INTO shim_t (name, score, day, big, flag)
              VALUES (${"t"}, ${12.5}, ${"2026-03-01"}, ${9007199254740991}, ${true})`;
    const [row] = await sql<{ score: unknown; day: unknown; big: unknown; flag: unknown }[]>`
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
    const rows = await sql.begin("read only", async (tx) => tx<{ n: number }[]>`SELECT count(*) AS n FROM shim_t`);
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    await expect(
      sql.begin("read only", async (tx) => tx`INSERT INTO shim_t (name) VALUES (${"nope"})`),
    ).rejects.toThrow();
  });

  it("runs literal text through sql.unsafe", async () => {
    const rows = await sql.unsafe<{ n: number }[]>("SELECT count(*) AS n FROM shim_t WHERE name = ?", ["a"]);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  /**
   * postgres.js's non-template `sql(...)` helpers. PMD uses four forms, and an
   * array of strings means different SQL in different positions - identifiers
   * after SELECT, values after IN - which only the surrounding text can settle.
   * These pin each form down, and pin down that an unresolvable position throws
   * rather than guessing.
   */
  describe("the sql(...) helpers", () => {
    it("quotes a dotted name as two identifiers, not one", async () => {
      const db = new URL(url!).pathname.replace(/^\//, "");
      const rows = await sql<{ n: number }[]>`SELECT count(*) AS n FROM ${sql(`${db}.shim_t`)}`;
      expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(0);
    });

    it("refuses an identifier containing a backtick", async () => {
      await expect(sql`SELECT * FROM ${sql("shim_t` WHERE 1=1 -- ")}`).rejects.toThrow(/backtick/);
    });

    it("builds columns and values together for an insert", async () => {
      const rows = [
        { name: "helper-a", big: 1 },
        { name: "helper-b", big: 2 },
      ];
      const res = await sql`INSERT INTO shim_t ${sql(rows as never, ...(Object.keys(rows[0]!) as never[]))}`;
      expect(res.count).toBe(2);
      const back = await sql<{ name: string }[]>`SELECT name FROM shim_t WHERE name LIKE 'helper-%' ORDER BY name`;
      expect(back.map((r) => r.name)).toEqual(["helper-a", "helper-b"]);
    });

    it("emits an identifier list after SELECT and a value list after IN", async () => {
      const cols = ["name", "big"];
      const picked = await sql<{ name: string; big: number }[]>`
        SELECT ${sql(cols)} FROM shim_t WHERE name IN ${sql(["helper-a", "helper-b"])} ORDER BY name`;
      expect(picked.map((r) => `${r.name}:${r.big}`)).toEqual(["helper-a:1", "helper-b:2"]);
    });

    it("matches nothing for an empty IN list rather than emitting IN ()", async () => {
      const rows = await sql`SELECT name FROM shim_t WHERE name IN ${sql([])}`;
      expect(rows).toHaveLength(0);
    });

    it("throws rather than guess when the position settles nothing", async () => {
      await expect(sql`SELECT * FROM shim_t WHERE name = ${sql(["helper-a"])}`).rejects.toThrow(/could not tell/);
    });
  });

  /**
   * `.count` is read off bare UPDATEs in the merge path, where it becomes the
   * "sourcesMoved" figure the API reports. A shim that returned only rows would
   * have made every one of those silently zero.
   */
  describe("result.count", () => {
    it("counts rows for a SELECT, without becoming an enumerable key", async () => {
      const rows = await sql`SELECT name FROM shim_t WHERE name LIKE 'helper-%'`;
      expect(rows.count).toBe(2);
      expect(Object.keys(rows)).toHaveLength(2);
      expect(JSON.parse(JSON.stringify(rows))).toHaveLength(2);
    });

    it("counts matched rather than changed rows for an UPDATE, as PostgreSQL did", async () => {
      // Both rows already hold these values, so a *changed*-rows count would be
      // 0 here. PostgreSQL's UPDATE count was the matched count, and PMD's
      // merge figures depend on that reading.
      const noop = await sql`UPDATE shim_t SET big = big WHERE name LIKE 'helper-%'`;
      expect(noop.count).toBe(2);

      const real = await sql`UPDATE shim_t SET big = 9 WHERE name LIKE 'helper-%'`;
      expect(real.count).toBe(2);
    });

    it("counts deleted rows", async () => {
      const del = await sql`DELETE FROM shim_t WHERE name LIKE 'helper-%'`;
      expect(del.count).toBe(2);
    });
  });

  it("reserves a connection that a second session genuinely waits on", async () => {
    // PMD's own code does not reserve; the review-bridge test does, to hold a
    // lock from outside the transaction under test. That needs a real second
    // connection, so this checks it is one.
    await sql`INSERT INTO shim_t (name, big) VALUES (${"reserved"}, 1)`;
    const [{ id }] = await sql<{ id: number }[]>`SELECT id FROM shim_t WHERE name = ${"reserved"}`;

    const held = await sql.reserve();
    await held.unsafe("START TRANSACTION");
    await held.unsafe("SELECT * FROM shim_t WHERE id = ? FOR UPDATE", [id]);

    let settled = false;
    const waiter = sql`UPDATE shim_t SET big = 2 WHERE id = ${id}`.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toBe(false);

    await held.unsafe("ROLLBACK");
    held.release();
    await waiter;
    expect(settled).toBe(true);
  });
});
