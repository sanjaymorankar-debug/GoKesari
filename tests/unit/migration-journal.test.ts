/**
 * drizzle/meta/_journal.json: the migrator applies only migrations newer than
 * the newest one a database has recorded. Two entries with the same `when`, or
 * one older than an entry before it, are skipped on a database that recorded
 * the other first — on 24 Oct 2026, 0088_revoked_sessions shared its
 * timestamp with the purchase-lists migration, was skipped on the test
 * database, and every session check failed until 0089 repaired it (D-99).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};
const entries = journal.entries;

describe("migration journal", () => {
  it("numbers the entries 0, 1, 2, … with the number at the front of each tag", () => {
    entries.forEach((e, i) => {
      expect(e.idx, e.tag).toBe(i);
      expect(e.tag.slice(0, 4), e.tag).toBe(String(i).padStart(4, "0"));
    });
  });

  it("gives every migration a later timestamp than the one before it", () => {
    const backwards = entries.slice(1).filter((e, i) => e.when <= entries[i].when);
    expect(backwards.map((e) => `${e.tag} (${e.when}) is not after ${entries[e.idx - 1].tag} (${entries[e.idx - 1].when})`)).toEqual([]);
  });

  it("lists every migration file, and no file that is not there", () => {
    const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();
    expect(entries.map((e) => e.tag).sort()).toEqual(files);
  });
});
