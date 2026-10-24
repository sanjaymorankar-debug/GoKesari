/**
 * Gathers one QA run's results (test-results/qa/<host>/*.jsonl, written by
 * tests/qa/lib/record.ts) into docs/testing/qa-runs/<date>-<target>[-label].json,
 * the evidence the master register is built from.
 *
 *   npx tsx scripts/qa/collect.ts --host test.gokesari.com [--label after-fixes] [--note "…"]
 *
 * Keeps the latest row per (case, project, check) — a re-run of one check
 * replaces its earlier row — and records the commit of the suite that ran.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResultRow } from "../../tests/qa/lib/record";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const host = arg("host") ?? "localhost:3000";
const label = arg("label");
const note = arg("note");
const dir = join("test-results", "qa", host.replace(/[^a-z0-9.-]/gi, "_"));
if (!existsSync(dir)) {
  console.error(`collect: no results in ${dir}`);
  process.exit(2);
}

const latest = new Map<string, ResultRow>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as ResultRow;
    const key = `${row.id}|${row.project}|${row.spec}|${row.test}`;
    const seen = latest.get(key);
    if (!seen || seen.at <= row.at) latest.set(key, row);
  }
}
const results = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id) || a.project.localeCompare(b.project) || a.test.localeCompare(b.test));
if (!results.length) {
  console.error(`collect: ${dir} holds no result rows`);
  process.exit(2);
}

const target = results[0].target;
const times = results.map((r) => r.at).sort();
const totals: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
for (const r of results) totals[r.status] = (totals[r.status] ?? 0) + 1;
const ids = new Set(results.map((r) => r.id));

let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // not a git checkout
}

const run = {
  target,
  host,
  label: label ?? null,
  note: note ?? null,
  suiteCommit: commit,
  startedAt: times[0],
  finishedAt: times.at(-1),
  cases: ids.size,
  rows: results.length,
  totals,
};
const day = (run.finishedAt ?? new Date().toISOString()).slice(0, 10);
const outDir = join("docs", "testing", "qa-runs");
mkdirSync(outDir, { recursive: true });
const name = `${day}-${target}${label ? `-${label.replace(/[^a-z0-9-]/gi, "-")}` : ""}.json`;
writeFileSync(join(outDir, name), JSON.stringify({ run, results }, null, 1) + "\n");
console.log(`collect: ${results.length} rows, ${ids.size} case ids (${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(", ")}) → ${join(outDir, name)}`);
