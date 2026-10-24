/**
 * The QA automation features themselves (module "QA automation", QA-010 …
 * QA-014): the plan is fully declared, production is never written to,
 * results are recorded, the register is complete, the agent, skills,
 * workflow and local environment are in place. These read the checkout and
 * the run files only, so they are safe on every site.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { blocked, expect, qa, type ResultRow } from "../lib/record";
import { HOST, IS_LOCAL } from "../lib/target";

const ROOT = process.cwd();
const catalog = () => JSON.parse(readFileSync(join(ROOT, "tests/qa/catalog/cases.json"), "utf8")) as { id: string }[];
const scenarios = () => JSON.parse(readFileSync(join(ROOT, "tests/qa/catalog/scenarios.json"), "utf8")) as { id: string }[];

function specFiles(dir = join(ROOT, "tests", "qa")): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? specFiles(full) : full.endsWith(".spec.ts") ? [full] : [];
  });
}

qa("TC-QA-001", "every case and scenario of the plan is declared in the suite (a check or manual() with its reason)", async () => {
  const declared = new Set<string>();
  for (const file of specFiles()) for (const m of readFileSync(file, "utf8").matchAll(/"((?:TC-[A-Z]+|SC)-\d+)"/g)) declared.add(m[1]);
  const ids = [...catalog(), ...scenarios()].map((c) => c.id);
  const missing = ids.filter((id) => !declared.has(id));
  expect(missing, `${missing.length} of ${ids.length} not declared: ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? " …" : ""}`).toEqual([]);
  return `${ids.length} IDs, all declared in ${specFiles().length} spec files`;
});

qa("TC-QA-002", "signed and local tiers are refused on gokesari.com, and the write guard throws there", async () => {
  // Evaluated in a child process pointed at production, whatever this run's site is.
  const out = execFileSync(
    "npx",
    ["tsx", "-e", "import('./tests/qa/lib/target').then((m)=>{const t=m.default??m;let w='';try{t.assertWritable('x')}catch(e){w=String(e.message)};console.log(JSON.stringify({target:t.TARGET,guest:t.tierRefusal('guest'),signed:t.tierRefusal('signed'),local:t.tierRefusal('local'),write:w}))})"],
    { cwd: ROOT, env: { ...process.env, E2E_BASE_URL: "https://gokesari.com" }, encoding: "utf8" },
  );
  const r = JSON.parse(out.trim().split("\n").at(-1)!) as { target: string; guest: string | null; signed: string | null; local: string | null; write: string };
  expect(r.target).toBe("production");
  expect(r.guest, "guest tier runs on production").toBeNull();
  expect(r.signed, "signed tier refused on production").toMatch(/not run on production/);
  expect(r.local, "local tier refused on production").toMatch(/not run on production/);
  expect(r.write, "write guard").toMatch(/Refusing to x on gokesari\.com/);
  return `production: guest runs; signed → "${r.signed}"; local → "${r.local}"; writes refused`;
});

qa("TC-QA-003", "each check of this run left a complete result row (ID, status, detail, tier, site, spec, time)", async () => {
  const dir = join(ROOT, "test-results", "qa", HOST.replace(/[^a-z0-9.-]/gi, "_"));
  if (!existsSync(dir)) blocked(`no result rows yet for ${HOST} (this check reads the rows of the checks before it)`);
  const rows = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow));
  if (!rows.length) blocked("no result rows yet");
  const bad = rows.filter(
    (r) =>
      !/^(TC-[A-Z]+|SC)-\d+$/.test(r.id) ||
      !["pass", "fail", "blocked", "skipped"].includes(r.status) ||
      typeof r.detail !== "string" ||
      !["guest", "signed", "local"].includes(r.tier) ||
      !r.spec.endsWith(".spec.ts") ||
      !r.host ||
      Number.isNaN(Date.parse(r.at)) ||
      (r.status === "fail" && (!r.detail || !r.evidence)),
  );
  expect(bad.slice(0, 5), `${bad.length} incomplete rows`).toEqual([]);
  return `${rows.length} rows, all complete (${new Set(rows.map((r) => r.id)).size} case IDs)`;
});

qa("TC-QA-004", "the master register lists every case and scenario once, with a status per site", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "qa-register-")), "register.xlsx");
  execFileSync("npx", ["tsx", "scripts/qa/build-register.ts", "--out", out], { cwd: ROOT, encoding: "utf8" });
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(out);
  for (const name of ["Read me", "Summary", "Test cases", "E2E scenarios", "Defects", "Runs", "Automation"]) expect(book.getWorksheet(name), `sheet ${name}`).toBeTruthy();
  const ids = (sheet: string) => {
    const ws = book.getWorksheet(sheet)!;
    const list: string[] = [];
    ws.eachRow((row, n) => {
      if (n > 1) list.push(String(row.getCell(1).value));
    });
    return list;
  };
  const header = (book.getWorksheet("Test cases")!.getRow(1).values as string[]).slice(1);
  for (const col of ["Local", "Staging (test.gokesari.com)", "Production (gokesari.com)", "Overall", "Automation", "Spec file(s)"]) expect(header, `column ${col}`).toContain(col);
  const tc = ids("Test cases");
  const sc = ids("E2E scenarios");
  expect(tc.length, "test case rows").toBe(catalog().length);
  expect(new Set(tc).size, "no duplicate case rows").toBe(tc.length);
  expect(sc.length, "scenario rows").toBe(scenarios().length);
  return `${tc.length} cases and ${sc.length} scenarios, each once, with Local / Staging / Production / Overall`;
});

qa("TC-QA-005", "the Claude QA agent and its skills are installed with a name and description", async () => {
  const files = [".claude/agents/gokesari-qa.md", ...["run", "signin", "write-test", "report"].map((s) => `.claude/skills/gokesari-qa-${s}/SKILL.md`)];
  const seen: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(front, `${file} frontmatter name`).toMatch(/^name:\s*\S+/m);
    expect(front, `${file} frontmatter description`).toMatch(/^description:\s*.{40,}/m);
    seen.push(front.match(/^name:\s*(\S+)/m)![1]);
  }
  return `installed: ${seen.join(", ")}`;
});

qa("TC-QA-006", "the QA workflow is scheduled and runnable by hand, and runs only the production-safe tier on the sites", async () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/qa.yml"), "utf8");
  expect(yml, "schedule").toMatch(/schedule:\s*\n\s*- cron:/);
  expect(yml, "by hand").toMatch(/workflow_dispatch:/);
  expect(yml, "both sites").toMatch(/site: \[test\.gokesari\.com, gokesari\.com\]/);
  const guestJob = yml.slice(yml.indexOf("  guest:"), yml.indexOf("  local:"));
  expect(guestJob, "guest job runs tests/qa/guest").toMatch(/playwright\.qa\.config\.ts tests\/qa\/guest/);
  expect(guestJob, "guest job uses no secrets").not.toMatch(/secrets\./);
  return "weekly schedule + workflow_dispatch; guest job runs tests/qa/guest on both sites with no secrets";
}, { partial: "a scheduled run itself is evidenced in GitHub Actions, not by this check" });

qa("TC-QA-007", "the local QA environment holds every account, shop and listing of the Test data sheet", async () => {
  if (!IS_LOCAL) blocked("reads the local world file (local run only)");
  const file = join(ROOT, "test-results", "qa", `world-${HOST.replace(/[^a-z0-9.-]/gi, "_")}.json`);
  if (!existsSync(file)) blocked(`no world file ${file} (run scripts/qa/local-up.sh)`);
  const w = JSON.parse(readFileSync(file, "utf8"));
  for (const role of ["customer", "customer2", "shop", "shopB", "shopC", "pending", "rider", "rider2", "admin", "ops", "oplim", "society"]) expect(w.users[role]?.id, `account ${role}`).toBeTruthy();
  for (const shop of ["A", "B", "C", "pending"]) expect(w.shops[shop]?.id, `shop ${shop}`).toBeTruthy();
  for (const l of ["packaged", "milk", "loose", "unpricedLoose", "sharedA", "sharedB", "offlineOnly", "lowStock", "premium"]) expect(w.listings[l]?.shopProductId, `listing ${l}`).toBeTruthy();
  expect(w.society?.id, "society").toBeTruthy();
  return `world ${w.run}: 12 accounts, 4 shops, 9 listings, a verified society`;
}, { tier: "local" });

interface RunFile {
  run: { target: string; suiteCommit: string; finishedAt: string };
  results: ResultRow[];
}

function runFiles(): RunFile[] {
  const dir = join(ROOT, "docs", "testing", "qa-runs");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunFile) : [];
}

qa("SC-36", "release check on both sites: the same suite commit ran on staging and on production", async () => {
  const runs = runFiles();
  const staging = runs.filter((r) => r.run.target === "staging");
  const production = runs.filter((r) => r.run.target === "production");
  if (!staging.length || !production.length) blocked(`needs collected runs of both sites (have staging ${staging.length}, production ${production.length})`);
  const common = staging.map((r) => r.run.suiteCommit).filter((c) => production.some((p) => p.run.suiteCommit === c));
  expect(common.length, "a suite commit with a run on both sites").toBeGreaterThan(0);
  const both = production.filter((p) => common.includes(p.run.suiteCommit)).at(-1)!;
  const guestRows = both.results.filter((r) => r.tier === "guest");
  expect(guestRows.length, "production-safe checks ran on production").toBeGreaterThan(20);
  expect(both.results.filter((r) => r.tier !== "guest").every((r) => r.status === "skipped"), "nothing but the guest tier ran on production").toBe(true);
  return `suite ${common.at(-1)}: staging and production runs; ${guestRows.length} production-safe checks on production`;
});

qa("SC-37", "signed-in staging run: the agent's sessions worked and signed-in checks passed there", async () => {
  const staging = runFiles().filter((r) => r.run.target === "staging");
  const signed = staging.flatMap((r) => r.results).filter((r) => r.tier === "signed" && r.status !== "skipped");
  if (!signed.length) blocked("needs a collected staging run with signed-in checks");
  const signedPass = signed.filter((r) => r.status === "pass");
  expect(signedPass.length, "signed-in checks that passed on staging").toBeGreaterThan(0);
  return `${signedPass.length} signed-in checks passed on test.gokesari.com (${new Set(signedPass.map((r) => r.id)).size} case IDs)`;
});
