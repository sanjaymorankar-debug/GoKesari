/**
 * DATABASE_PREPARED_STATEMENTS=on (src/server/db/index.ts): Drizzle sends every
 * query through `unsafe()`, inside a transaction too. postgres-js gives each
 * transaction and savepoint its own scoped `sql`, so the wrapper must reach
 * those as well — before 02-Nov-2026 it did not, and every statement inside
 * db.transaction (checkout, cancel) still cost two round trips.
 */
import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import { withPreparedStatements } from "@/server/db";

type Call = { query: string; options: Record<string, unknown> | undefined };

/** A stand-in for a postgres-js `sql`: records unsafe() options, opens scopes like begin/savepoint do. */
function fakeSql(calls: Call[]): postgres.Sql {
  const make = (): Record<string, unknown> => {
    const scoped: Record<string, unknown> = {
      unsafe: (query: string, _args?: unknown[], options?: Record<string, unknown>) => {
        calls.push({ query, options });
        return Promise.resolve([]);
      },
      savepoint: (...args: unknown[]) => (args.find((a) => typeof a === "function") as (s: unknown) => unknown)(make()),
    };
    return scoped;
  };
  const root = make();
  root.begin = (...args: unknown[]) => (args.find((a) => typeof a === "function") as (s: unknown) => unknown)(make());
  return root as unknown as postgres.Sql;
}

describe("withPreparedStatements", () => {
  it("prepares queries on the pool, inside a transaction and inside a savepoint", async () => {
    const calls: Call[] = [];
    const sql = withPreparedStatements(fakeSql(calls));

    await sql.unsafe("select 1");
    await sql.begin("read write", async (tx) => {
      await tx.unsafe("select 2");
      await tx.savepoint(async (sp) => {
        await sp.unsafe("select 3");
      });
    });

    expect(calls.map((c) => [c.query, c.options?.prepare])).toEqual([
      ["select 1", true],
      ["select 2", true],
      ["select 3", true],
    ]);
  });

  it("keeps a caller's explicit prepare: false", async () => {
    const calls: Call[] = [];
    const sql = withPreparedStatements(fakeSql(calls));
    await sql.begin(async (tx) => {
      await tx.unsafe("select 4", [], { prepare: false });
    });
    expect(calls[0].options?.prepare).toBe(false);
  });
});
