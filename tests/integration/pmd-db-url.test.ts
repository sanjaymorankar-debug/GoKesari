/**
 * The product master's connection (src/server/pmd/db.ts createSql) opens a Neon
 * copy-paste URL: channel_binding=require is a libpq-only setting that postgres.js
 * would otherwise send to the server, which refuses it.
 *
 * Its TLS comes from the URL's sslmode. GoKesari's own database server is reached
 * with sslmode=verify-full, which must check the server's certificate (postgres.js
 * "verify-full"); Neon's sslmode=require only encrypts, as before.
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

describe("product master connection TLS (sslmode)", () => {
  /** The TLS setting postgres.js will use; nothing connects until a query runs. */
  function sslFor(url: string) {
    const sql = createSql(url, { max: 1 });
    opened.push(sql);
    return sql.options.ssl;
  }
  const base = "postgresql://gokesari_app:secret@db.gokesari.com:5432/gokesari";

  it.each([
    ["no sslmode", "", false],
    ["sslmode=disable", "?sslmode=disable", false],
    ["sslmode=require (Neon)", "?sslmode=require", "require"],
    ["sslmode=prefer", "?sslmode=prefer", "require"],
    ["sslmode=verify-full", "?sslmode=verify-full", "verify-full"],
    ["sslmode=verify-ca (checked as strictly)", "?sslmode=verify-ca", "verify-full"],
    ["verify-full beside channel_binding", "?sslmode=verify-full&channel_binding=require", "verify-full"],
  ])("%s", (_label, query, expected) => {
    expect(sslFor(`${base}${query}`)).toBe(expected);
  });

  it("does not send sslmode to the server as a setting", () => {
    const sql = createSql(`${base}?sslmode=verify-full`, { max: 1 });
    opened.push(sql);
    expect(sql.options.connection).not.toHaveProperty("sslmode");
    expect(sql.options.connection).not.toHaveProperty("ssl");
  });
});
