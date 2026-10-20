/**
 * The product master's connection (src/server/pmd/db.ts createSql) opens a Neon
 * copy-paste URL: channel_binding=require is a libpq-only setting that postgres.js
 * would otherwise send to the server, which refuses it. On a split site the product
 * master reads the seller database straight from SELLER_DATABASE_URL.
 */
import { afterAll, describe, expect, it } from "vitest";

import { createSql, type Sql } from "@/server/pmd/db";

const opened: Sql[] = [];

afterAll(async () => {
  await Promise.all(opened.map((sql) => sql.end()));
});

describe("product master connection URL", () => {
  it("opens a URL that carries channel_binding=require", async () => {
    const u = new URL(process.env.TEST_DATABASE_URL!);
    u.searchParams.set("channel_binding", "require");
    const sql = createSql(` ${u.toString()}\n`, { max: 1 });
    opened.push(sql);
    const [{ ok }] = await sql<{ ok: number }[]>`select 1 as ok`;
    expect(ok).toBe(1);
  });
});
