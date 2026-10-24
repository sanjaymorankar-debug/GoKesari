/**
 * Builds the master test register — every test case and E2E scenario of the
 * plan with how it is automated and its latest execution status on each site —
 * from the catalog (tests/qa/catalog), the specs (tests/qa/**), the collected
 * runs (docs/testing/qa-runs/*.json) and the defect log (docs/testing/qa-defects.json).
 *
 *   npx tsx scripts/qa/build-register.ts [--out docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx]
 *
 * Per site, a case's status comes from the newest run that holds it:
 * Fail if any of its checks failed; Pass when they passed ("Pass (partial)"
 * when a check covers only part of the Expected result or a sibling check was
 * blocked); Blocked when every check was blocked; "Not run (rule)" when the
 * tier does not run on that site (e.g. a writing case on production).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ExcelJS from "exceljs";

import type { ResultRow } from "../../tests/qa/lib/record";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : join("docs", "testing", "GOKESARI_MASTER_TEST_REGISTER.xlsx");
const TARGETS = ["local", "staging", "production"] as const;
type TargetName = (typeof TARGETS)[number];

interface CaseRow {
  id: string;
  module: string;
  features: string;
  title: string;
  type?: string;
  priority: string;
  role?: string;
  method?: string;
  steps?: string;
  expected: string;
  journey?: string;
}

interface RunFile {
  run: { target: TargetName; host: string; label: string | null; suiteCommit: string; startedAt: string; finishedAt: string; cases: number; rows: number; totals: Record<string, number>; note?: string | null };
  results: ResultRow[];
  file: string;
}

interface Defect {
  id: string;
  title: string;
  cases: string[];
  severity: string;
  found: string;
  actual: string;
  expected: string;
  fix: string;
  status: string;
  fixedIn?: string;
  retest?: string;
}

const read = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;

/* ---------------------------------------------------------------- inputs */

const cases = read<CaseRow[]>(join("tests", "qa", "catalog", "cases.json"));
const scenarios = read<{ id: string; title: string; features: string; priority: string; journey: string; expected: string }[]>(join("tests", "qa", "catalog", "scenarios.json")).map(
  (s): CaseRow => ({ id: s.id, module: "E2E scenario", features: s.features, title: s.title, priority: s.priority, expected: s.expected, journey: s.journey }),
);
const defects = existsSync(join("docs", "testing", "qa-defects.json")) ? read<{ defects: Defect[] }>(join("docs", "testing", "qa-defects.json")).defects : [];

const runDir = join("docs", "testing", "qa-runs");
const runs: RunFile[] = existsSync(runDir)
  ? readdirSync(runDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ ...read<Omit<RunFile, "file">>(join(runDir, f)), file: f }))
      .sort((a, b) => a.run.finishedAt.localeCompare(b.run.finishedAt))
  : [];

/** Which spec files mention each ID, and whether as qa() or manual(). */
function scanSpecs() {
  const found = new Map<string, { specs: Set<string>; manual: boolean; automated: boolean }>();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".spec.ts") ? [full] : [];
    });
  for (const file of walk(join("tests", "qa"))) {
    const src = readFileSync(file, "utf8");
    const ids = (text: string) => [...text.matchAll(/"((?:TC-[A-Z]+|SC)-\d+)"/g)].map((m) => m[1]);
    // IDs named in manual(...) calls; every other ID literal in a spec is an automated check
    // (qa() takes literals or a constant list of them).
    const manualIds = new Set([...src.matchAll(/\bmanual\(\s*(\[[^\]]*\]|"[^"]*")/g)].flatMap((m) => ids(m[1])));
    const counts = new Map<string, number>();
    for (const id of ids(src)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const manualCounts = new Map<string, number>();
    for (const m of src.matchAll(/\bmanual\(\s*(\[[^\]]*\]|"[^"]*")/g)) for (const id of ids(m[1])) manualCounts.set(id, (manualCounts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      const entry = found.get(id) ?? { specs: new Set<string>(), manual: false, automated: false };
      entry.specs.add(relative(join("tests", "qa"), file));
      if (manualIds.has(id)) entry.manual = true;
      if (n > (manualCounts.get(id) ?? 0)) entry.automated = true;
      found.set(id, entry);
    }
  }
  return found;
}
const automation = scanSpecs();

/* ------------------------------------------------------------ aggregation */

interface Outcome {
  status: string;
  detail: string;
  at: string;
  tiers: Set<string>;
  run?: string;
}

function aggregate(rows: ResultRow[]): Omit<Outcome, "run"> {
  const statuses = new Set(rows.map((r) => r.status));
  const at = rows.map((r) => r.at).sort().at(-1) ?? "";
  const tiers = new Set(rows.map((r) => r.tier));
  const fails = rows.filter((r) => r.status === "fail");
  const blocked = rows.filter((r) => r.status === "blocked");
  const partials = rows.filter((r) => r.status === "pass" && r.partial);
  const describe = (list: ResultRow[], max = 3) => list.slice(0, max).map((r) => `${r.project === "mobile" ? "[phone] " : ""}${r.detail}`).join(" ‖ ");
  if (fails.length) return { status: "Fail", detail: describe(fails), at, tiers };
  if (statuses.has("pass")) {
    if (partials.length || blocked.length) {
      const notes = [...partials.map((r) => `not covered: ${r.partial}`), ...blocked.map((r) => `blocked: ${r.detail}`)];
      return { status: "Pass (partial)", detail: [...new Set(notes)].slice(0, 3).join(" ‖ "), at, tiers };
    }
    return { status: "Pass", detail: describe(rows.filter((r) => r.status === "pass"), 2), at, tiers };
  }
  if (blocked.length) {
    const manual = blocked.every((r) => r.detail.startsWith("not automated:"));
    return { status: manual ? "Manual" : "Blocked", detail: [...new Set(blocked.map((r) => r.detail))].slice(0, 2).join(" ‖ "), at, tiers };
  }
  return { status: "Not run (rule)", detail: [...new Set(rows.map((r) => r.detail))].slice(0, 1).join(""), at, tiers };
}

/** Per target and id: the rows of the newest run that holds that id. */
const latest = new Map<string, Outcome>();
for (const target of TARGETS) {
  const byId = new Map<string, { run: RunFile; rows: ResultRow[] }>();
  for (const run of runs.filter((r) => r.run.target === target)) {
    const grouped = new Map<string, ResultRow[]>();
    for (const row of run.results) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
    for (const [id, rows] of grouped) byId.set(id, { run, rows }); // later runs replace earlier ones
  }
  for (const [id, { run, rows }] of byId) latest.set(`${target}|${id}`, { ...aggregate(rows), run: run.file });
}

const RANK: Record<string, number> = { Fail: 6, Pass: 5, "Pass (partial)": 4, Blocked: 3, Manual: 2, "Not run (rule)": 1, "Not run": 0 };

function overall(id: string) {
  const outcomes = TARGETS.map((t) => latest.get(`${t}|${id}`)).filter((o): o is Outcome => Boolean(o));
  if (!outcomes.length) return "Not run";
  if (outcomes.some((o) => o.status === "Fail")) return "Fail";
  return outcomes.map((o) => o.status).sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
}

function defectsFor(id: string) {
  return defects.filter((d) => d.cases.includes(id) && d.status !== "Not a defect");
}

function automationOf(id: string) {
  const a = automation.get(id);
  if (!a) return { kind: "Not automated", specs: "" };
  const kind = a.automated && a.manual ? "Automated + manual part" : a.automated ? "Automated" : "Manual (declared)";
  return { kind, specs: [...a.specs].sort().join(", ") };
}

/* --------------------------------------------------------------- workbook */

const FILL: Record<string, string> = {
  Pass: "FFC6EFCE",
  "Pass (partial)": "FFE2F0D9",
  Fail: "FFFFC7CE",
  Blocked: "FFFFEB9C",
  Manual: "FFDDEBF7",
  "Not run (rule)": "FFEDEDED",
  "Not run": "FFF2F2F2",
};

function styleHeader(sheet: ExcelJS.Worksheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF8B2E16" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 32;
  sheet.views = [{ state: "frozen", ySplit: 1, xSplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

function paint(cell: ExcelJS.Cell) {
  const color = FILL[String(cell.value ?? "")];
  if (color) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

async function main() {
  const book = new ExcelJS.Workbook();
  book.creator = "GoKesari QA suite (scripts/qa/build-register.ts)";
  book.created = new Date();
  const asOf = runs.at(-1)?.run.finishedAt ?? new Date().toISOString();

  // Sheets in reading order; each is filled below.
  const readme = book.addWorksheet("Read me");
  const summary = book.addWorksheet("Summary");
  const tcSheet = book.addWorksheet("Test cases");
  const scSheet = book.addWorksheet("E2E scenarios");
  const ds = book.addWorksheet("Defects");
  const rs = book.addWorksheet("Runs");
  const au = book.addWorksheet("Automation");

  /* Read me */
  readme.columns = [{ width: 26 }, { width: 120 }];
  const lines: [string, string][] = [
    ["GoKesari — master test register", ""],
    ["As of", `${asOf.slice(0, 16).replace("T", " ")} UTC (newest run included)`],
    ["What it is", "Every test case (test-cases.xlsx → 'Test cases') and every E2E scenario of the plan, with how it is automated and its latest execution status on the local server, test.gokesari.com (staging) and gokesari.com (production)."],
    ["Built from", "tests/qa/catalog (the plan), tests/qa/**/*.spec.ts (automation), docs/testing/qa-runs/*.json (results of each run), docs/testing/qa-defects.json (defects). Re-build: npx tsx scripts/qa/build-register.ts"],
    ["Status per site", "From the newest run on that site that holds the case. Pass = every check behaved as the Expected result says. Pass (partial) = passed, but a check covers only part of the Expected result or a sibling check was blocked (the detail says what). Fail = differs (detail and Defect). Blocked = could not be tested there (detail says why). Manual = declared not automatable (detail says what is needed). Not run (rule) = the case's tier does not run on that site (production runs the production-safe tier only). Not run = no run has reached it."],
    ["Overall", "Fail if any site's latest result is Fail; otherwise the best of the sites' results (Pass > Pass (partial) > Blocked > Manual > Not run)."],
    ["Tiers", "guest: production-safe (public pages, requests that must be refused) — runs everywhere. signed: signs in test accounts and writes test data — local and staging. local: needs the local database or secret (rules, suspensions, time-based, OTP flows) — local only."],
    ["Production rule", "Nothing on gokesari.com signs in, writes or pays; no sandbox keys or test cards there (CLAUDE.md). Payments on staging use Cashfree sandbox data only."],
    ["Runs", `${runs.length} run file(s): see the 'Runs' sheet.`],
  ];
  lines.forEach(([a, b], i) => {
    const row = readme.addRow([a, b]);
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.getCell(1).font = { bold: true };
    if (i === 0) row.font = { bold: true, size: 14 };
  });

  /* Test cases + scenarios */
  const columns = [
    { header: "ID", key: "id", width: 13 },
    { header: "Module", key: "module", width: 24 },
    { header: "Feature IDs", key: "features", width: 16 },
    { header: "Test case / scenario", key: "title", width: 44 },
    { header: "Priority", key: "priority", width: 8 },
    { header: "Role", key: "role", width: 10 },
    { header: "Method", key: "method", width: 9 },
    { header: "Automation", key: "automation", width: 16 },
    { header: "Spec file(s)", key: "specs", width: 30 },
    { header: "Tier", key: "tier", width: 9 },
    { header: "Local", key: "local", width: 13 },
    { header: "Staging (test.gokesari.com)", key: "staging", width: 13 },
    { header: "Production (gokesari.com)", key: "production", width: 13 },
    { header: "Overall", key: "overall", width: 13 },
    { header: "Defect", key: "defect", width: 10 },
    { header: "Result detail (latest, per site)", key: "detail", width: 70 },
    { header: "Last run (UTC)", key: "lastRun", width: 17 },
    { header: "Steps / journey", key: "steps", width: 50 },
    { header: "Expected result", key: "expected", width: 50 },
  ];
  const fill = (sheet: ExcelJS.Worksheet, list: CaseRow[]) => {
    sheet.columns = columns;
    for (const c of list) {
      const per = Object.fromEntries(TARGETS.map((t) => [t, latest.get(`${t}|${c.id}`)])) as Record<TargetName, Outcome | undefined>;
      const auto = automationOf(c.id);
      const tiers = new Set(TARGETS.flatMap((t) => [...(per[t]?.tiers ?? [])]));
      const detail = TARGETS.filter((t) => per[t] && per[t]!.detail)
        .map((t) => `${t}: ${per[t]!.detail}`)
        .join("\n")
        .slice(0, 1500);
      const lastRun = TARGETS.map((t) => per[t]?.at ?? "").sort().at(-1)?.slice(0, 16).replace("T", " ") ?? "";
      const row = sheet.addRow({
        id: c.id,
        module: c.module,
        features: c.features,
        title: c.title,
        priority: c.priority,
        role: c.role ?? "",
        method: c.method ?? "",
        automation: auto.kind,
        specs: auto.specs,
        tier: [...tiers].join(", "),
        local: per.local?.status ?? "Not run",
        staging: per.staging?.status ?? "Not run",
        production: per.production?.status ?? "Not run",
        overall: overall(c.id),
        defect: defectsFor(c.id).map((d) => d.id).join(", "),
        detail,
        lastRun,
        steps: c.steps ?? c.journey ?? "",
        expected: c.expected,
      });
      row.alignment = { vertical: "top", wrapText: true };
      for (const key of ["local", "staging", "production", "overall"]) paint(row.getCell(key));
    }
    styleHeader(sheet);
  };
  fill(tcSheet, cases);
  fill(scSheet, scenarios);

  /* Summary */
  const statuses = ["Pass", "Pass (partial)", "Fail", "Blocked", "Manual", "Not run (rule)", "Not run"];
  summary.columns = [{ header: "Module", key: "m", width: 40 }, { header: "Cases", key: "n", width: 8 }, { header: "Automated", key: "a", width: 11 }, { header: "P0", key: "p0", width: 6 }, ...statuses.map((s) => ({ header: `Overall: ${s}`, key: s, width: 12 })), { header: "P0 not passed", key: "p0bad", width: 12 }];
  const modules = [...new Set([...cases, ...scenarios].map((c) => c.module))];
  const totals: Record<string, number> = { n: 0, a: 0, p0: 0, p0bad: 0, ...Object.fromEntries(statuses.map((s) => [s, 0])) };
  for (const m of modules) {
    const list = [...cases, ...scenarios].filter((c) => c.module === m);
    const row: Record<string, number | string> = { m, n: list.length, a: list.filter((c) => automation.get(c.id)?.automated).length, p0: list.filter((c) => c.priority === "P0").length };
    for (const s of statuses) row[s] = list.filter((c) => overall(c.id) === s).length;
    row.p0bad = list.filter((c) => c.priority === "P0" && !["Pass", "Pass (partial)"].includes(overall(c.id))).length;
    for (const k of Object.keys(totals)) totals[k] += Number(row[k] ?? 0);
    summary.addRow(row);
  }
  const totalRow = summary.addRow({ m: "Total", ...totals });
  totalRow.font = { bold: true };
  summary.addRow({});
  summary.addRow({ m: "Per site (cases and scenarios)" }).font = { bold: true };
  for (const t of TARGETS) {
    const row: Record<string, number | string> = { m: t === "staging" ? "Staging (test.gokesari.com)" : t === "production" ? "Production (gokesari.com)" : "Local server" };
    for (const s of statuses) row[s] = [...cases, ...scenarios].filter((c) => (latest.get(`${t}|${c.id}`)?.status ?? "Not run") === s).length;
    summary.addRow(row);
  }
  styleHeader(summary);

  /* Defects */
  ds.columns = [
    { header: "Defect", key: "id", width: 8 },
    { header: "Title", key: "title", width: 40 },
    { header: "Severity", key: "severity", width: 9 },
    { header: "Status", key: "status", width: 16 },
    { header: "Cases", key: "cases", width: 22 },
    { header: "Found", key: "found", width: 22 },
    { header: "Actual", key: "actual", width: 60 },
    { header: "Expected", key: "expected", width: 50 },
    { header: "Fix", key: "fix", width: 50 },
    { header: "Fixed in", key: "fixedIn", width: 16 },
    { header: "Re-test", key: "retest", width: 40 },
  ];
  for (const d of defects) ds.addRow({ ...d, cases: d.cases.join(", "), fixedIn: d.fixedIn ?? "", retest: d.retest ?? "" }).alignment = { vertical: "top", wrapText: true };
  styleHeader(ds);

  /* Runs */
  rs.columns = [
    { header: "Run file", key: "file", width: 40 },
    { header: "Site", key: "target", width: 11 },
    { header: "Host", key: "host", width: 20 },
    { header: "Label", key: "label", width: 16 },
    { header: "Suite commit", key: "commit", width: 12 },
    { header: "Started (UTC)", key: "start", width: 17 },
    { header: "Finished (UTC)", key: "end", width: 17 },
    { header: "Case IDs", key: "cases", width: 9 },
    { header: "Checks", key: "rows", width: 8 },
    { header: "Pass", key: "pass", width: 7 },
    { header: "Fail", key: "fail", width: 7 },
    { header: "Blocked", key: "blocked", width: 8 },
    { header: "Skipped (rule)", key: "skipped", width: 9 },
    { header: "Note", key: "note", width: 50 },
  ];
  for (const r of runs) {
    rs.addRow({
      file: r.file,
      target: r.run.target,
      host: r.run.host,
      label: r.run.label ?? "",
      commit: r.run.suiteCommit,
      start: r.run.startedAt.slice(0, 16).replace("T", " "),
      end: r.run.finishedAt.slice(0, 16).replace("T", " "),
      cases: r.run.cases,
      rows: r.run.rows,
      pass: r.run.totals.pass ?? 0,
      fail: r.run.totals.fail ?? 0,
      blocked: r.run.totals.blocked ?? 0,
      skipped: r.run.totals.skipped ?? 0,
      note: r.run.note ?? "",
    });
  }
  styleHeader(rs);

  /* Automation */
  au.columns = [{ header: "Spec file (tests/qa/…)", key: "spec", width: 46 }, { header: "Case IDs", key: "n", width: 9 }, { header: "IDs", key: "ids", width: 120 }];
  const bySpec = new Map<string, string[]>();
  for (const [id, a] of automation) for (const s of a.specs) bySpec.set(s, [...(bySpec.get(s) ?? []), id]);
  for (const [spec, ids] of [...bySpec].sort()) au.addRow({ spec, n: ids.length, ids: ids.sort().join(", ") }).alignment = { wrapText: true, vertical: "top" };
  styleHeader(au);

  await book.xlsx.writeFile(OUT);
  const all = [...cases, ...scenarios];
  const count = (s: string) => all.filter((c) => overall(c.id) === s).length;
  console.log(
    `build-register: ${all.length} cases+scenarios (${all.filter((c) => automation.get(c.id)).length} declared in specs) — overall ${statuses.map((s) => `${s} ${count(s)}`).join(", ")} → ${OUT}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
