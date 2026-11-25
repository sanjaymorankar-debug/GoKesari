// scripts/db/renumber-migrations.mjs: a branch's own migrations are moved
// past the ones its base gained, as the staging queue does on a journal-only
// merge conflict (docs/staging-queue/README.md, "Migration numbers").
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/db/renumber-migrations.mjs");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const entry = (idx: number, name: string, when = 1000 + idx): Entry =>
  ({ idx, version: "7", when, tag: `${String(idx).padStart(4, "0")}_${name}`, breakpoints: true });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "renumber-"));
  dirs.push(dir);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  const write = (f: string, s: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), s); };
  const journal = (entries: Entry[]) => write("drizzle/meta/_journal.json", JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2) + "\n");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const run = (...a: string[]) => execFileSync("node", [SCRIPT, ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "base");
  return { dir, git, write, journal, read, run };
}

function start() {
  const r = repo();
  r.journal([entry(0, "init"), entry(1, "shops")]);
  r.write("drizzle/0000_init.sql", "-- init\n");
  r.write("drizzle/0001_shops.sql", "-- shops\n");
  r.write("src/schema.ts", "// tables\n");
  r.git("add", "-A"); r.git("commit", "-qm", "base");
  return r;
}

describe("renumber-migrations", () => {
  it("moves two branch migrations past the two the base gained, with their rollback scripts and references", () => {
    const r = start();
    r.git("switch", "-qc", "feature");
    r.journal([entry(0, "init"), entry(1, "shops"), entry(2, "topups", 5000), entry(3, "topups_more", 5100)]);
    r.write("drizzle/0002_topups.sql", "-- 0002_topups\n");
    r.write("drizzle/0003_topups_more.sql", "-- needs 0002_topups\n");
    r.write("scripts/rollback-0002-topups.sql", "-- undo migration 0002 (then delete the 0002 row)\n");
    r.write("docs/topups.md", "Migration 0002 and 0003; rollback: scripts/rollback-0002-topups.sql. Unrelated: 10002.\n");
    r.write("src/schema.ts", "// tables\n// topups (0002_topups), see migration 0002\n");
    r.git("add", "-A"); r.git("commit", "-qm", "feature");

    r.git("switch", "-q", "base");
    r.journal([entry(0, "init"), entry(1, "shops"), entry(2, "tax", 3000), entry(3, "books", 3100)]);
    r.write("drizzle/0002_tax.sql", "-- tax\n");
    r.write("drizzle/0003_books.sql", "-- books\n");
    r.git("add", "-A"); r.git("commit", "-qm", "base gains two");

    r.git("switch", "-q", "feature");
    expect(() => r.git("merge", "-q", "--no-edit", "base")).toThrow();
    const out = r.run("base");
    expect(out).toContain("0002_topups → 0004_topups");
    expect(out).toContain("0003_topups_more → 0005_topups_more");
    expect(out).toContain("src/schema.ts (0002)"); // a modified file: listed, not changed
    r.git("commit", "-q", "--no-edit");

    const j = JSON.parse(r.read("drizzle/meta/_journal.json")).entries as Entry[];
    expect(j.map((e) => e.tag)).toEqual(["0000_init", "0001_shops", "0002_tax", "0003_books", "0004_topups", "0005_topups_more"]);
    j.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < j.length; i++) expect(j[i].when).toBeGreaterThan(j[i - 1].when);

    expect(r.read("drizzle/0004_topups.sql")).toBe("-- 0004_topups\n");
    expect(r.read("drizzle/0005_topups_more.sql")).toBe("-- needs 0004_topups\n");
    expect(r.read("drizzle/0002_tax.sql")).toBe("-- tax\n");
    expect(existsSync(join(r.dir, "drizzle/0002_topups.sql"))).toBe(false);
    expect(r.read("scripts/rollback-0004-topups.sql")).toBe("-- undo migration 0004 (then delete the 0004 row)\n");
    expect(r.read("docs/topups.md")).toBe("Migration 0004 and 0005; rollback: scripts/rollback-0004-topups.sql. Unrelated: 10002.\n");
    expect(r.read("src/schema.ts")).toBe("// tables\n// topups (0004_topups), see migration 0002\n");
    expect(r.git("status", "--porcelain")).toBe("");
  });

  it("does nothing when the branch already follows the base", () => {
    const r = start();
    r.git("switch", "-qc", "feature");
    r.journal([entry(0, "init"), entry(1, "shops"), entry(2, "topups")]);
    r.write("drizzle/0002_topups.sql", "-- topups\n");
    r.git("add", "-A"); r.git("commit", "-qm", "feature");
    expect(r.run("base")).toContain("nothing to do");
    expect(r.git("status", "--porcelain")).toBe("");
  });

  it("refuses a base whose journal is not contiguous", () => {
    const r = start();
    r.journal([entry(0, "init"), entry(1, "shops"), { ...entry(2, "x"), tag: "0003_x" }]);
    r.git("commit", "-qam", "broken");
    r.git("switch", "-qc", "feature");
    expect(() => r.run("base")).toThrow();
  });
});
