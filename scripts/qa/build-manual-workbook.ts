/**
 * Builds the GoKesari MANUAL test workbook — the execution template a person
 * fills in while testing test.gokesari.com by hand, with results and evidence.
 *
 * Structure follows ISO/IEC/IEEE 29119-3:2021 (test documentation, the
 * successor of IEEE 829): document control, test plan, test scenarios (test
 * conditions), test cases (test procedures), execution log, evidence register,
 * defect (incident) log, traceability matrix, summary and completion sign-off.
 *
 *   npx tsx scripts/qa/build-manual-workbook.ts [--out <file.xlsx>] [--date 2026-11-20]
 *
 * Inputs
 *   tests/qa/catalog/cases.json, scenarios.json      the plan (test-cases.xlsx): every case and journey
 *   docs/testing/manual/test-scenarios.json          scenario → case grouping
 *   docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx  automation + latest staging result
 *   test-cases.xlsx (Coverage)                       feature list for the RTM
 *
 * Every count on Summary, Test Scenarios, Traceability and Sign-off is a
 * formula over the Status columns, so the workbook updates as results are typed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

// ───────────────────────────── inputs ─────────────────────────────

const arg = (name: string, dflt: string) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt;
const DATE = arg("--date", new Date().toISOString().slice(0, 10));
const OUT = arg("--out", join("docs", "testing", "manual", `GOKESARI_MANUAL_TEST_WORKBOOK_${DATE}.xlsx`));
const MANUAL_DIR = join("docs", "testing", "manual");
/**
 * Versions of the workbook (docs/testing/manual/revisions.json): one entry per issue, oldest first.
 * The Cover shows the last one as the Version and all of them as the Revision history.
 */
interface Revision {
  version: string;
  date: string;
  change: string;
}
const REVISIONS: Revision[] = JSON.parse(readFileSync(join(MANUAL_DIR, "revisions.json"), "utf8"));

interface Case {
  id: string;
  module: string;
  features: string;
  title: string;
  type: string;
  priority: string;
  role: string;
  method: string;
  preconditions: string;
  steps: string;
  expected: string;
  scenario?: string;
  origin?: string;
  /** Starting status: planned cases start "Not Applicable" until they reach staging. */
  status?: string;
  remarks?: string;
}
interface Journey {
  id: string;
  title: string;
  features: string;
  priority: string;
  preconditions?: string;
  journey: string;
  expected: string;
  origin?: string;
  status?: string;
  remarks?: string;
}
interface Scenario {
  id: string;
  module: string;
  title: string;
  description: string;
  caseIds?: string[];
}
interface Feature {
  id: string;
  module: string;
  feature: string;
  status: string;
}

const featureList = (f: string) => f.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

/**
 * Where a case or journey came from, read from the plan (scripts/qa/plan_workbook.py add-json writes it):
 * a case's Source / a journey's Origin starts "Added <dd-Mmm-yyyy>" (feature on staging after the 08-Nov
 * plan) or "Planned - <release>, not built yet (<day>)" (starts Not Applicable); a plan case whose Expected
 * result was brought up to date carries "; Updated <day> …" / "; Corrected <day> …" in its Source.
 */
const PLAN_ORIGIN = "Plan (08-Nov-2026)";
const DAY = String.raw`\d{2}-[A-Z][a-z]{2}-\d{4}`;
function originOf(text: string | undefined): Pick<Case, "origin" | "status" | "remarks"> {
  const t = text ?? "";
  const added = new RegExp(`^Added (${DAY})`).exec(t);
  if (added) return { origin: `New (${added[1]})` };
  const planned = new RegExp(`^(Planned - (.+?), not built yet \\(${DAY}\\))`).exec(t);
  if (planned) {
    return {
      origin: planned[1],
      status: "Not Applicable",
      remarks: `Planned (${planned[2]}). Set to Not Run when it reaches test.gokesari.com; check the Expected result against the built screens.`,
    };
  }
  const updated = new RegExp(`; ((?:Updated|Corrected) ${DAY}.*)$`).exec(t);
  return { origin: updated ? `${PLAN_ORIGIN}; ${updated[1]}` : PLAN_ORIGIN };
}
const planCases = readJson<(Case & { source?: string })[]>(join("tests", "qa", "catalog", "cases.json")).map((c) => ({
  ...c,
  ...originOf(c.source),
  // A case retired by a later decision says so in its Expected result ("Not applicable since <day>: …"); it starts
  // Not Applicable, like a planned one, so it never counts as not run (e.g. TC-TERR-*, territory = franchise, 23-Nov-2026).
  ...(/^Not applicable since/i.test(c.expected) ? { status: "Not Applicable", remarks: `Retired: ${c.expected}` } : {}),
}));
const planJourneys = readJson<Journey[]>(join("tests", "qa", "catalog", "scenarios.json")).map((j) => ({
  ...j,
  ...originOf(j.origin),
}));
const scenarioMap = readJson<Scenario[]>(join(MANUAL_DIR, "test-scenarios.json"));

const fmtDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}-${d.getUTCFullYear()}`;
};

const cases: Case[] = [...planCases];
const journeys: Journey[] = [...planJourneys];
const scenarios: Scenario[] = [...scenarioMap];
const isPlan = (o: string | undefined) => (o ?? "").startsWith(PLAN_ORIGIN);
const newCases = cases.filter((c) => !isPlan(c.origin));
const newJourneys = journeys.filter((j) => !isPlan(j.origin));

const statusOf = (c: Case) => c.status ?? "Not Run";
const nBy = (cs: Case[], st: string) => cs.filter((c) => statusOf(c) === st).length;
/** Same rule as the Scenario status formula. */
function rollup(cs: Case[]) {
  const n = cs.length,
    na = nBy(cs, "Not Applicable"),
    nr = nBy(cs, "Not Run");
  if (!n) return "No cases";
  if (nBy(cs, "Fail")) return "Fail";
  if (nBy(cs, "Blocked")) return "Blocked";
  if (na === n) return "Not Applicable";
  if (nr + na === n) return "Not Run";
  return nr ? "In Progress" : "Pass";
}

// Case → scenario
const scenarioOf = new Map<string, string>();
for (const s of scenarios) for (const id of s.caseIds ?? []) scenarioOf.set(id, s.id);
for (const c of cases) if (c.scenario) scenarioOf.set(c.id, c.scenario);
const missing = cases.filter((c) => !scenarioOf.has(c.id)).map((c) => c.id);
if (missing.length) throw new Error(`cases without a scenario: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " …" : ""}`);
const ids = new Set<string>();
for (const c of cases) {
  if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
  ids.add(c.id);
}
for (const s of scenarios) for (const id of s.caseIds ?? []) if (!ids.has(id)) throw new Error(`${s.id} lists unknown case ${id}`);

// Module order: as first seen in the case list; cases sorted by module then id order of appearance.
const modules: string[] = [];
for (const c of cases) if (!modules.includes(c.module)) modules.push(c.module);
const caseOrder = new Map(cases.map((c, i) => [c.id, i]));
const scenarioOrder = new Map(scenarios.map((s, i) => [s.id, i]));
cases.sort(
  (a, b) =>
    modules.indexOf(a.module) - modules.indexOf(b.module) ||
    (scenarioOrder.get(scenarioOf.get(a.id)!)! - scenarioOrder.get(scenarioOf.get(b.id)!)!) ||
    caseOrder.get(a.id)! - caseOrder.get(b.id)!,
);
scenarios.sort(
  (a, b) => modules.indexOf(a.module) - modules.indexOf(b.module) || scenarioOrder.get(a.id)! - scenarioOrder.get(b.id)!,
);

// Register: automation + latest staging result per id.
interface RegRow {
  automation: string;
  staging: string;
}
const reg = new Map<string, RegRow>();
// Features (RTM) from test-cases.xlsx Coverage sheet.
const features: Feature[] = [];

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return String(v.result ?? "");
    if ("text" in v) return String((v as { text: string }).text);
  }
  return String(v);
};

// ───────────────────────────── styling ─────────────────────────────

const FONT = "Arial";
const C = {
  navy: "FF1F3864",
  amber: "FFC65911",
  input: "FFFFF2CC",
  ref: "FFF2F2F2",
  band: "FFD9E1F2",
  white: "FFFFFFFF",
  pass: "FFC6EFCE",
  passText: "FF006100",
  fail: "FFFFC7CE",
  failText: "FF9C0006",
  blocked: "FFFFEB9C",
  blockedText: "FF9C5700",
  na: "FFE7E6E6",
  border: "FFBFBFBF",
};
const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const thin: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: C.border } },
  left: { style: "thin", color: { argb: C.border } },
  bottom: { style: "thin", color: { argb: C.border } },
  right: { style: "thin", color: { argb: C.border } },
};

const MAXROW = 3000; // formula ranges cover rows a tester may add
const DATE_FMT = "dd-mmm-yyyy";

const wb = new ExcelJS.Workbook();
wb.creator = "GoKesari QA";
wb.created = new Date(`${DATE}T00:00:00Z`);
wb.calcProperties = { fullCalcOnLoad: true };

type Col = { header: string; key: string; width: number; input?: boolean; wrap?: boolean; date?: boolean; center?: boolean };

function addTable(ws: ExcelJS.Worksheet, cols: Col[], opts: { freezeCols?: number } = {}) {
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 32;
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { name: FONT, bold: true, size: 10, color: { argb: C.white } };
    cell.fill = fill(c.input ? C.amber : C.navy);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thin;
  });
  ws.views = [{ state: "frozen", xSplit: opts.freezeCols ?? 1, ySplit: 1, zoomScale: 90 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
}

function styleBody(ws: ExcelJS.Worksheet, cols: Col[], fromRow: number, toRow: number) {
  for (let r = fromRow; r <= toRow; r++) {
    const row = ws.getRow(r);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.font = { name: FONT, size: 10, ...(cell.font?.color ? { color: cell.font.color } : {}), ...(cell.font?.underline ? { underline: cell.font.underline } : {}) };
      cell.alignment = { vertical: "top", wrapText: c.wrap !== false, horizontal: c.center ? "center" : "left" };
      cell.border = thin;
      if (c.input) cell.fill = fill(C.input);
      if (c.date) cell.numFmt = DATE_FMT;
    });
  }
}

function estimateHeight(texts: Array<[string, number]>, max = 165) {
  let lines = 1;
  for (const [t, width] of texts) {
    const per = Math.max(8, Math.floor(width * 1.15));
    const n = String(t ?? "")
      .split("\n")
      .reduce((s, l) => s + Math.max(1, Math.ceil(l.length / per)), 0);
    lines = Math.max(lines, n);
  }
  return Math.min(max, Math.max(15, lines * 12.6 + 3));
}

// exceljs has worksheet.dataValidations at runtime but not in its typings.
type RangeValidations = { add(range: string, v: ExcelJS.DataValidation): void };
const validations = (ws: ExcelJS.Worksheet) => (ws as unknown as { dataValidations: RangeValidations }).dataValidations;

function list(ws: ExcelJS.Worksheet, range: string, listRef: string, prompt?: string) {
  validations(ws).add(range, {
    type: "list",
    allowBlank: true,
    formulae: [listRef],
    showErrorMessage: true,
    errorStyle: "warning",
    errorTitle: "Not in the list",
    error: "Pick a value from the list (Lists sheet).",
    ...(prompt ? { showInputMessage: true, promptTitle: "", prompt } : {}),
  });
}

function statusColours(ws: ExcelJS.Worksheet, ref: string, col: string, first: number) {
  const rule = (text: string, bg: string, fg: string, priority: number): ExcelJS.ConditionalFormattingRule => ({
    type: "expression",
    priority,
    formulae: [`$${col}${first}="${text}"`],
    style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: bg } }, font: { color: { argb: fg }, bold: true } },
  });
  ws.addConditionalFormatting({
    ref,
    rules: [
      rule("Pass", C.pass, C.passText, 1),
      rule("Fail", C.fail, C.failText, 2),
      rule("Blocked", C.blocked, C.blockedText, 3),
      rule("Not Applicable", C.na, "FF595959", 4),
    ],
  });
}

const title = (ws: ExcelJS.Worksheet, cell: string, text: string, size = 16) => {
  const c = ws.getCell(cell);
  c.value = text;
  c.font = { name: FONT, bold: true, size, color: { argb: C.navy } };
};
const section = (ws: ExcelJS.Worksheet, row: number, text: string, span = 6) => {
  ws.mergeCells(row, 1, row, span);
  const c = ws.getCell(row, 1);
  c.value = text;
  c.font = { name: FONT, bold: true, size: 11, color: { argb: C.white } };
  c.fill = fill(C.navy);
  c.alignment = { vertical: "middle" };
  ws.getRow(row).height = 20;
};
function kv(ws: ExcelJS.Worksheet, row: number, key: string, value: ExcelJS.CellValue, opts: { input?: boolean; span?: number; height?: number; date?: boolean } = {}) {
  const k = ws.getCell(row, 1);
  k.value = key;
  k.font = { name: FONT, bold: true, size: 10 };
  k.fill = fill(C.band);
  k.alignment = { vertical: "top", wrapText: true };
  k.border = thin;
  const span = opts.span ?? 6;
  if (span > 2) ws.mergeCells(row, 2, row, span);
  const v = ws.getCell(row, 2);
  v.value = value;
  v.font = { name: FONT, size: 10 };
  v.alignment = { vertical: "top", wrapText: true };
  v.border = thin;
  if (opts.input) v.fill = fill(C.input);
  if (opts.date) v.numFmt = DATE_FMT;
  if (opts.height) ws.getRow(row).height = opts.height;
}
function grid(ws: ExcelJS.Worksheet, row: number, headers: string[], rows: ExcelJS.CellValue[][], opts: { inputCols?: number[]; heights?: number } = {}) {
  headers.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    c.font = { name: FONT, bold: true, size: 10, color: { argb: C.white } };
    c.fill = fill(opts.inputCols?.includes(i) ? C.amber : C.navy);
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    c.border = thin;
  });
  rows.forEach((r, ri) => {
    r.forEach((v, i) => {
      const c = ws.getCell(row + 1 + ri, i + 1);
      c.value = v;
      c.font = { name: FONT, size: 10 };
      c.alignment = { vertical: "top", wrapText: true };
      c.border = thin;
      if (opts.inputCols?.includes(i)) c.fill = fill(C.input);
    });
    if (opts.heights) ws.getRow(row + 1 + ri).height = opts.heights;
  });
  return row + 1 + rows.length;
}

// ───────────────────────────── lists ─────────────────────────────

const LISTS: Record<string, string[]> = {
  Status: ["Not Run", "Pass", "Fail", "Blocked", "Not Applicable"],
  Severity: ["S1 - Critical", "S2 - Major", "S3 - Minor", "S4 - Trivial"],
  Priority: ["P0", "P1", "P2"],
  "Defect status": ["New", "Open", "In Progress", "Fixed - Ready for Retest", "Reopened", "Closed", "Deferred", "Rejected", "Duplicate"],
  "Browser / device": [
    "Chrome - Windows",
    "Chrome - macOS",
    "Safari - macOS",
    "Edge - Windows",
    "Firefox - desktop",
    "Chrome - Android phone",
    "Safari - iPhone",
    "GoKesari Android app",
    "Other (say in Remarks)",
  ],
  Cycle: ["Cycle 1", "Cycle 2", "Cycle 3", "Retest", "Regression", "Smoke"],
  "Evidence type": [
    "Screenshot",
    "Screen recording",
    "Network log (HAR)",
    "Browser console log",
    "Email / SMS / WhatsApp copy",
    "PDF / invoice / download",
    "API request and response",
    "Database query output",
    "Other",
  ],
  "Yes / No": ["Yes", "No", "Not needed"],
  Recommendation: ["Go", "Go with conditions", "No-go"],
  Environment: ["test.gokesari.com (staging)", "Local server", "gokesari.com (production, read-only)"],
  Type: ["Positive", "Negative", "Boundary", "Security", "Regression", "Usability", "Compatibility"],
};
const listRef = (name: string) => {
  const col = Object.keys(LISTS).indexOf(name) + 1;
  const letter = colLetter(col);
  return `Lists!$${letter}$2:$${letter}$${LISTS[name].length + 1}`;
};
function colLetter(n: number) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ───────────────────────────── build ─────────────────────────────

async function main() {
  // Register + coverage
  const regWb = new ExcelJS.Workbook();
  await regWb.xlsx.readFile(join("docs", "testing", "GOKESARI_MASTER_TEST_REGISTER.xlsx"));
  const regAsOf = cellText(regWb.getWorksheet("Read me")!.getRow(2).getCell(2).value).slice(0, 16);
  for (const name of ["Test cases", "E2E scenarios"]) {
    const ws = regWb.getWorksheet(name)!;
    const head = Array.from(ws.getRow(1).values as ExcelJS.CellValue[], cellText);
    const iId = head.indexOf("ID"),
      iAuto = head.indexOf("Automation"),
      iStg = head.findIndex((h) => h.startsWith("Staging"));
    ws.eachRow((row, r) => {
      if (r === 1) return;
      const v = row.values as ExcelJS.CellValue[];
      reg.set(cellText(v[iId]), { automation: cellText(v[iAuto]), staging: cellText(v[iStg]) });
    });
  }
  const tcWb = new ExcelJS.Workbook();
  await tcWb.xlsx.readFile("test-cases.xlsx");
  tcWb.getWorksheet("Coverage")!.eachRow((row, r) => {
    if (r === 1) return;
    const v = row.values as ExcelJS.CellValue[];
    features.push({ id: cellText(v[1]), module: cellText(v[2]), feature: cellText(v[3]), status: cellText(v[4]) });
  });

  const nCases = cases.length;
  const lastCase = nCases + 1;
  const nJ = journeys.length;
  const nowIst = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).replace(":", ".");

  // Sheet order (tabs)
  const wsCover = wb.addWorksheet("Cover", { properties: { tabColor: { argb: C.navy } } });
  const wsHow = wb.addWorksheet("How to use", { properties: { tabColor: { argb: C.navy } } });
  const wsPlan = wb.addWorksheet("Test Plan", { properties: { tabColor: { argb: C.navy } } });
  const wsSum = wb.addWorksheet("Summary", { properties: { tabColor: { argb: "FF548235" } } });
  const wsTS = wb.addWorksheet("Test Scenarios", { properties: { tabColor: { argb: "FF2F75B5" } } });
  const wsTC = wb.addWorksheet("Test Cases", { properties: { tabColor: { argb: "FF2F75B5" } } });
  const wsE2E = wb.addWorksheet("E2E Scenarios", { properties: { tabColor: { argb: "FF2F75B5" } } });
  const wsLog = wb.addWorksheet("Execution Log", { properties: { tabColor: { argb: C.amber } } });
  const wsEv = wb.addWorksheet("Evidence Register", { properties: { tabColor: { argb: C.amber } } });
  const wsDef = wb.addWorksheet("Defect Log", { properties: { tabColor: { argb: "FFC00000" } } });
  const wsRtm = wb.addWorksheet("Traceability", { properties: { tabColor: { argb: "FF7030A0" } } });
  const wsSign = wb.addWorksheet("Sign-off", { properties: { tabColor: { argb: "FF548235" } } });
  const wsLists = wb.addWorksheet("Lists", { properties: { tabColor: { argb: "FF808080" } } });

  // ── Lists
  Object.entries(LISTS).forEach(([name, values], i) => {
    const col = i + 1;
    const h = wsLists.getCell(1, col);
    h.value = name;
    h.font = { name: FONT, bold: true, color: { argb: C.white } };
    h.fill = fill(C.navy);
    values.forEach((v, j) => {
      const c = wsLists.getCell(j + 2, col);
      c.value = v;
      c.font = { name: FONT, size: 10 };
    });
    wsLists.getColumn(col).width = Math.max(16, ...values.map((v) => v.length + 2));
  });
  wsLists.getCell(14, 1).value = "Values used by the drop-downs. Add a value at the end of a list only if the drop-down range is widened too.";
  wsLists.getCell(14, 1).font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };

  // ── Test Cases
  const tcCols: Col[] = [
    { header: "TC ID", key: "id", width: 14 },
    { header: "Scenario ID", key: "ts", width: 12 },
    { header: "Module", key: "module", width: 20 },
    { header: "Feature / requirement IDs", key: "features", width: 14 },
    { header: "Test case", key: "title", width: 36 },
    { header: "Type", key: "type", width: 11, center: true },
    { header: "Priority", key: "priority", width: 8, center: true },
    { header: "Role / actor", key: "role", width: 11 },
    { header: "Method", key: "method", width: 8, center: true },
    { header: "Preconditions / test data", key: "pre", width: 30 },
    { header: "Test steps", key: "steps", width: 46 },
    { header: "Expected result", key: "expected", width: 46 },
    { header: "Automation (register)", key: "auto", width: 12, center: true },
    { header: `Last automated result - staging (register ${regAsOf.slice(0, 10)})`, key: "stg", width: 13, center: true },
    { header: "Case origin", key: "origin", width: 12 },
    { header: "Actual result", key: "actual", width: 40, input: true },
    { header: "Status", key: "status", width: 12, input: true, center: true },
    { header: "Severity (if Fail)", key: "sev", width: 12, input: true },
    { header: "Defect ID", key: "defect", width: 10, input: true },
    { header: "Evidence ID(s)", key: "ev", width: 20, input: true },
    { header: "Evidence link (path or URL)", key: "evlink", width: 30, input: true },
    { header: "Open evidence", key: "open", width: 9, center: true },
    { header: "Browser / device", key: "device", width: 16, input: true },
    { header: "Build / release (commit or PR)", key: "build", width: 14, input: true },
    { header: "Cycle", key: "cycle", width: 10, input: true },
    { header: "Tested by", key: "tester", width: 12, input: true },
    { header: "Executed on", key: "date", width: 12, input: true, date: true },
    { header: "Remarks", key: "remarks", width: 28, input: true },
  ];
  addTable(wsTC, tcCols, { freezeCols: 1 });
  cases.forEach((c, i) => {
    const r = i + 2;
    const rg = reg.get(c.id);
    const row = wsTC.getRow(r);
    row.values = [
      c.id,
      scenarioOf.get(c.id),
      c.module,
      featureList(c.features).join(", "),
      c.title,
      c.type,
      c.priority,
      c.role,
      c.method,
      c.preconditions || "",
      c.steps,
      c.expected,
      rg ? rg.automation.replace("Manual (declared)", "Manual") : "Not in register",
      rg ? rg.staging : "-",
      c.origin,
      "",
      statusOf(c),
    ];
    if (c.remarks) row.getCell(28).value = c.remarks;
    row.getCell(22).value = { formula: `IF(U${r}="","",HYPERLINK(U${r},"Open"))`, result: "" };
    row.height = estimateHeight([
      [c.title, 36],
      [c.preconditions, 30],
      [c.steps, 46],
      [c.expected, 46],
    ]);
  });
  styleBody(wsTC, tcCols, 2, lastCase);
  for (let r = 2; r <= lastCase; r++) {
    wsTC.getCell(r, 22).font = { name: FONT, size: 10, color: { argb: "FF0563C1" }, underline: true };
    for (const cidx of [13, 14, 15]) wsTC.getCell(r, cidx).fill = fill(C.ref);
  }
  list(wsTC, `Q2:Q${MAXROW}`, listRef("Status"));
  list(wsTC, `R2:R${MAXROW}`, listRef("Severity"));
  list(wsTC, `W2:W${MAXROW}`, listRef("Browser / device"));
  list(wsTC, `Y2:Y${MAXROW}`, listRef("Cycle"));
  validations(wsTC).add(`AA2:AA${MAXROW}`, {
    type: "date",
    operator: "greaterThan",
    allowBlank: true,
    formulae: [new Date("2026-01-01T00:00:00Z")],
    showErrorMessage: true,
    errorStyle: "warning",
    error: "Type a date, e.g. 21-Nov-2026",
  });
  statusColours(wsTC, `Q2:Q${MAXROW}`, "Q", 2);
  wsTC.addConditionalFormatting({
    ref: `R2:S${MAXROW}`,
    rules: [
      {
        type: "expression",
        priority: 5,
        formulae: [`AND($Q2="Fail",OR($R2="",$S2=""))`],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } } },
      },
    ],
  });
  wsTC.addConditionalFormatting({
    ref: `T2:T${MAXROW}`,
    rules: [
      {
        type: "expression",
        priority: 6,
        formulae: [`AND(OR($Q2="Fail",AND($Q2="Pass",$G2="P0")),$T2="")`],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } } },
      },
    ],
  });

  const R = (col: string) => `'Test Cases'!$${col}$2:$${col}$${MAXROW}`;
  const STATUS = R("Q"),
    MOD = R("C"),
    PRIO = R("G"),
    TSCOL = R("B"),
    FEAT = R("D");

  // ── Test Scenarios
  const tsCols: Col[] = [
    { header: "Scenario ID", key: "id", width: 12 },
    { header: "Module", key: "module", width: 22 },
    { header: "Test scenario", key: "title", width: 48 },
    { header: "Description", key: "desc", width: 52 },
    { header: "Feature / requirement IDs", key: "features", width: 22 },
    { header: "Highest priority", key: "prio", width: 9, center: true },
    { header: "Test cases", key: "n", width: 8, center: true },
    { header: "Pass", key: "pass", width: 7, center: true },
    { header: "Fail", key: "fail", width: 7, center: true },
    { header: "Blocked", key: "blocked", width: 8, center: true },
    { header: "Not Applicable", key: "na", width: 9, center: true },
    { header: "Not Run", key: "notrun", width: 8, center: true },
    { header: "Scenario status", key: "status", width: 13, center: true },
    { header: "TC IDs", key: "tcs", width: 40 },
    { header: "Remarks", key: "remarks", width: 28, input: true },
  ];
  addTable(wsTS, tsCols, { freezeCols: 1 });
  const casesByTs = new Map<string, Case[]>();
  for (const c of cases) {
    const t = scenarioOf.get(c.id)!;
    casesByTs.set(t, [...(casesByTs.get(t) ?? []), c]);
  }
  const prioRank = (p: string) => ["P0", "P1", "P2"].indexOf(p);
  scenarios.forEach((s, i) => {
    const r = i + 2;
    const cs = casesByTs.get(s.id) ?? [];
    const feats = [...new Set(cs.flatMap((c) => c.features.split(/[,;]/).map((x) => x.trim()).filter(Boolean)))];
    const prio = cs.map((c) => c.priority).sort((a, b) => prioRank(a) - prioRank(b))[0] ?? "";
    const cnt = (st: string) => ({ formula: `COUNTIFS(${TSCOL},$A${r},${STATUS},"${st}")`, result: nBy(cs, st) });
    wsTS.getRow(r).values = [
      s.id,
      s.module,
      s.title,
      s.description,
      feats.join(", "),
      prio,
      { formula: `COUNTIF(${TSCOL},$A${r})`, result: cs.length },
      cnt("Pass"),
      cnt("Fail"),
      cnt("Blocked"),
      cnt("Not Applicable"),
      cnt("Not Run"),
      {
        formula: `IF(G${r}=0,"No cases",IF(I${r}>0,"Fail",IF(J${r}>0,"Blocked",IF(K${r}=G${r},"Not Applicable",IF(L${r}+K${r}=G${r},"Not Run",IF(L${r}>0,"In Progress","Pass"))))))`,
        result: rollup(cs),
      },
      cs.map((c) => c.id).join(", "),
    ];
    wsTS.getRow(r).height = estimateHeight([
      [s.title, 48],
      [s.description, 52],
      [cs.map((c) => c.id).join(", "), 40],
    ], 120);
  });
  const lastTs = scenarios.length + 1;
  styleBody(wsTS, tsCols, 2, lastTs);
  statusColours(wsTS, `M2:M${lastTs}`, "M", 2);

  // ── E2E Scenarios
  const e2eCols: Col[] = [
    { header: "Scenario ID", key: "id", width: 10 },
    { header: "End-to-end scenario", key: "title", width: 32 },
    { header: "Workflows / features", key: "features", width: 16 },
    { header: "Priority", key: "prio", width: 8, center: true },
    { header: "Preconditions / test data", key: "pre", width: 28 },
    { header: "Journey (steps)", key: "journey", width: 56 },
    { header: "Expected outcome", key: "expected", width: 44 },
    { header: "Automation (register)", key: "auto", width: 12, center: true },
    { header: "Last automated result - staging", key: "stg", width: 13, center: true },
    { header: "Case origin", key: "origin", width: 12 },
    { header: "Actual result", key: "actual", width: 40, input: true },
    { header: "Status", key: "status", width: 12, input: true, center: true },
    { header: "Severity (if Fail)", key: "sev", width: 12, input: true },
    { header: "Defect ID(s)", key: "defect", width: 11, input: true },
    { header: "Evidence ID(s)", key: "ev", width: 20, input: true },
    { header: "Evidence link (path or URL)", key: "evlink", width: 30, input: true },
    { header: "Open evidence", key: "open", width: 9, center: true },
    { header: "Browser / device", key: "device", width: 16, input: true },
    { header: "Build / release", key: "build", width: 14, input: true },
    { header: "Cycle", key: "cycle", width: 10, input: true },
    { header: "Tested by", key: "tester", width: 12, input: true },
    { header: "Executed on", key: "date", width: 12, input: true, date: true },
    { header: "Remarks", key: "remarks", width: 28, input: true },
  ];
  addTable(wsE2E, e2eCols, { freezeCols: 1 });
  journeys.forEach((j, i) => {
    const r = i + 2;
    const rg = reg.get(j.id);
    wsE2E.getRow(r).values = [
      j.id,
      j.title,
      j.features,
      j.priority,
      j.preconditions ?? "See Test Plan - test accounts and data",
      j.journey,
      j.expected,
      rg ? rg.automation.replace("Manual (declared)", "Manual") : "Not in register",
      rg ? rg.staging : "-",
      j.origin,
      "",
      j.status ?? "Not Run",
    ];
    if (j.remarks) wsE2E.getCell(r, 23).value = j.remarks;
    wsE2E.getCell(r, 17).value = { formula: `IF(P${r}="","",HYPERLINK(P${r},"Open"))`, result: "" };
    wsE2E.getRow(r).height = estimateHeight([
      [j.journey, 56],
      [j.expected, 44],
    ], 190);
  });
  const lastJ = nJ + 1;
  styleBody(wsE2E, e2eCols, 2, lastJ);
  for (let r = 2; r <= lastJ; r++) {
    wsE2E.getCell(r, 17).font = { name: FONT, size: 10, color: { argb: "FF0563C1" }, underline: true };
    for (const cidx of [8, 9, 10]) wsE2E.getCell(r, cidx).fill = fill(C.ref);
  }
  list(wsE2E, `L2:L500`, listRef("Status"));
  list(wsE2E, `M2:M500`, listRef("Severity"));
  list(wsE2E, `R2:R500`, listRef("Browser / device"));
  list(wsE2E, `T2:T500`, listRef("Cycle"));
  statusColours(wsE2E, `L2:L500`, "L", 2);

  // ── Execution Log
  const logCols: Col[] = [
    { header: "Exec ID", key: "id", width: 10, input: true },
    { header: "Cycle", key: "cycle", width: 10, input: true },
    { header: "Executed on", key: "date", width: 12, input: true, date: true },
    { header: "TC / SC ID", key: "tc", width: 14, input: true },
    { header: "Test case / scenario (looked up)", key: "title", width: 44 },
    { header: "Environment", key: "env", width: 22, input: true },
    { header: "Build / release", key: "build", width: 14, input: true },
    { header: "Browser / device", key: "device", width: 16, input: true },
    { header: "Tested by", key: "tester", width: 12, input: true },
    { header: "Status", key: "status", width: 12, input: true, center: true },
    { header: "Defect ID", key: "defect", width: 10, input: true },
    { header: "Evidence ID(s)", key: "ev", width: 20, input: true },
    { header: "Notes", key: "notes", width: 36, input: true },
  ];
  addTable(wsLog, logCols, { freezeCols: 1 });
  const LOGROWS = 600;
  for (let r = 2; r <= LOGROWS + 1; r++) {
    wsLog.getCell(r, 5).value = {
      formula: `IF(D${r}="","",IFERROR(INDEX('Test Cases'!$E$2:$E$${MAXROW},MATCH(D${r},'Test Cases'!$A$2:$A$${MAXROW},0)),IFERROR(INDEX('E2E Scenarios'!$B$2:$B$500,MATCH(D${r},'E2E Scenarios'!$A$2:$A$500,0)),"ID not found")))`,
      result: "",
    };
  }
  styleBody(wsLog, logCols, 2, LOGROWS + 1);
  list(wsLog, `B2:B${LOGROWS + 1}`, listRef("Cycle"));
  list(wsLog, `F2:F${LOGROWS + 1}`, listRef("Environment"));
  list(wsLog, `H2:H${LOGROWS + 1}`, listRef("Browser / device"));
  list(wsLog, `J2:J${LOGROWS + 1}`, listRef("Status"));
  statusColours(wsLog, `J2:J${LOGROWS + 1}`, "J", 2);

  // ── Evidence Register
  const evCols: Col[] = [
    { header: "Evidence ID", key: "id", width: 22, input: true },
    { header: "TC / SC ID", key: "tc", width: 14, input: true },
    { header: "Exec ID", key: "exec", width: 10, input: true },
    { header: "Evidence type", key: "type", width: 20, input: true },
    { header: "File name", key: "file", width: 34, input: true },
    { header: "Location / link (path or URL)", key: "link", width: 40, input: true },
    { header: "Open", key: "open", width: 8, center: true },
    { header: "What it shows", key: "what", width: 40, input: true },
    { header: "Captured on", key: "date", width: 12, input: true, date: true },
    { header: "Captured by", key: "by", width: 12, input: true },
    { header: "Personal data masked?", key: "mask", width: 11, input: true },
    { header: "Remarks", key: "remarks", width: 26, input: true },
  ];
  addTable(wsEv, evCols, { freezeCols: 1 });
  const EVROWS = 1000;
  for (let r = 2; r <= EVROWS + 1; r++) {
    wsEv.getCell(r, 7).value = { formula: `IF(F${r}="","",HYPERLINK(F${r},"Open"))`, result: "" };
  }
  styleBody(wsEv, evCols, 2, EVROWS + 1);
  for (let r = 2; r <= EVROWS + 1; r++) wsEv.getCell(r, 7).font = { name: FONT, size: 10, color: { argb: "FF0563C1" }, underline: true };
  list(wsEv, `D2:D${EVROWS + 1}`, listRef("Evidence type"));
  list(wsEv, `K2:K${EVROWS + 1}`, listRef("Yes / No"));

  // ── Defect Log
  const defCols: Col[] = [
    { header: "Defect ID", key: "id", width: 10, input: true },
    { header: "Title", key: "title", width: 36, input: true },
    { header: "TC / SC ID(s)", key: "tc", width: 14, input: true },
    { header: "Module", key: "module", width: 20, input: true },
    { header: "Severity", key: "sev", width: 13, input: true },
    { header: "Priority", key: "prio", width: 8, input: true, center: true },
    { header: "Status", key: "status", width: 16, input: true },
    { header: "Environment / URL", key: "env", width: 26, input: true },
    { header: "Build / release", key: "build", width: 14, input: true },
    { header: "Browser / device", key: "device", width: 16, input: true },
    { header: "Steps to reproduce", key: "steps", width: 40, input: true },
    { header: "Expected result", key: "exp", width: 30, input: true },
    { header: "Actual result", key: "act", width: 30, input: true },
    { header: "Evidence ID(s)", key: "ev", width: 20, input: true },
    { header: "Reported by", key: "by", width: 12, input: true },
    { header: "Reported on", key: "on", width: 12, input: true, date: true },
    { header: "Assigned to", key: "to", width: 12, input: true },
    { header: "Fix reference (PR / commit)", key: "fix", width: 14, input: true },
    { header: "Fixed on", key: "fixed", width: 12, input: true, date: true },
    { header: "Retest on", key: "rt", width: 12, input: true, date: true },
    { header: "Retest result", key: "rtr", width: 12, input: true },
    { header: "Retest evidence ID", key: "rte", width: 18, input: true },
    { header: "Remarks", key: "remarks", width: 26, input: true },
  ];
  addTable(wsDef, defCols, { freezeCols: 1 });
  const DEFROWS = 300;
  styleBody(wsDef, defCols, 2, DEFROWS + 1);
  list(wsDef, `E2:E${DEFROWS + 1}`, listRef("Severity"));
  list(wsDef, `F2:F${DEFROWS + 1}`, listRef("Priority"));
  list(wsDef, `G2:G${DEFROWS + 1}`, listRef("Defect status"));
  list(wsDef, `J2:J${DEFROWS + 1}`, listRef("Browser / device"));
  list(wsDef, `U2:U${DEFROWS + 1}`, listRef("Status"));
  wsDef.addConditionalFormatting({
    ref: `E2:E${DEFROWS + 1}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`LEFT($E2,2)="S1"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } }, font: { color: { argb: C.failText }, bold: true } } },
      { type: "expression", priority: 2, formulae: [`LEFT($E2,2)="S2"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.blocked } }, font: { color: { argb: C.blockedText }, bold: true } } },
    ],
  });
  statusColours(wsDef, `U2:U${DEFROWS + 1}`, "U", 2);

  // ── Traceability (RTM)
  const rtmCols: Col[] = [
    { header: "Feature / requirement ID", key: "id", width: 14 },
    { header: "Module / area", key: "module", width: 20 },
    { header: "Feature / requirement", key: "feature", width: 44 },
    { header: "Development status (source)", key: "status", width: 26 },
    { header: "Test scenarios", key: "ts", width: 26 },
    { header: "Test cases", key: "n", width: 8, center: true },
    { header: "Pass", key: "pass", width: 7, center: true },
    { header: "Fail", key: "fail", width: 7, center: true },
    { header: "Blocked", key: "blocked", width: 8, center: true },
    { header: "Not Run", key: "notrun", width: 8, center: true },
    { header: "Coverage status", key: "cov", width: 16, center: true },
    { header: "Remarks", key: "remarks", width: 26, input: true },
  ];
  addTable(wsRtm, rtmCols, { freezeCols: 1 });
  const featCases = (fid: string) => cases.filter((c) => c.features.split(/[,;]/).map((x) => x.trim()).includes(fid));
  const seenF = new Set<string>();
  const rtmRows = features.filter((f) => f.id && !seenF.has(f.id) && seenF.add(f.id));
  // features named on cases but missing from the list
  for (const c of cases)
    for (const fid of c.features.split(/[,;]/).map((x) => x.trim()).filter(Boolean))
      if (!seenF.has(fid)) {
        seenF.add(fid);
        rtmRows.push({ id: fid, module: c.module, feature: "(named on test cases; not in the 28-Sep feature list)", status: "" });
      }
  rtmRows.forEach((f, i) => {
    const r = i + 2;
    const cs = featCases(f.id);
    const tsIds = [...new Set(cs.map((c) => scenarioOf.get(c.id)!))];
    // Exact-token match on the normalised "A, B, C" list in column D (fast native COUNTIFS;
    // a plain "*id*" wildcard would let GS-01 match GS-010).
    const m2 = (st?: string) => {
      const s = st ? `,${STATUS},"${st}"` : "";
      return [`$A${r}`, `$A${r}&", *"`, `"*, "&$A${r}`, `"*, "&$A${r}&", *"`].map((p) => `COUNTIFS(${FEAT},${p}${s})`).join("+");
    };
    wsRtm.getRow(r).values = [
      f.id,
      f.module,
      f.feature,
      f.status,
      tsIds.join(", "),
      { formula: m2(), result: cs.length },
      { formula: m2("Pass"), result: nBy(cs, "Pass") },
      { formula: m2("Fail"), result: nBy(cs, "Fail") },
      { formula: m2("Blocked"), result: nBy(cs, "Blocked") },
      { formula: m2("Not Run"), result: nBy(cs, "Not Run") },
      {
        // N = Not Applicable cases (planned features not on staging yet)
        formula: (() => {
          const N = `(F${r}-G${r}-H${r}-I${r}-J${r})`;
          return `IF(F${r}=0,"No test case",IF(H${r}>0,"At risk - failing",IF(${N}=F${r},"Planned / not applicable",IF(G${r}+${N}=F${r},"Covered - passed",IF(J${r}+${N}=F${r},"Not yet tested","In progress")))))`;
        })(),
        result: (() => {
          const na = nBy(cs, "Not Applicable");
          if (!cs.length) return "No test case";
          if (nBy(cs, "Fail")) return "At risk - failing";
          if (na === cs.length) return "Planned / not applicable";
          if (nBy(cs, "Pass") + na === cs.length) return "Covered - passed";
          if (nBy(cs, "Not Run") + na === cs.length) return "Not yet tested";
          return "In progress";
        })(),
      },
    ];
    wsRtm.getRow(r).height = estimateHeight([
      [f.feature, 44],
      [f.status, 26],
      [tsIds.join(", "), 26],
    ], 90);
  });
  const lastRtm = rtmRows.length + 1;
  styleBody(wsRtm, rtmCols, 2, lastRtm);
  wsRtm.addConditionalFormatting({
    ref: `K2:K${lastRtm}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`$K2="Covered - passed"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.pass } }, font: { color: { argb: C.passText } } } },
      { type: "expression", priority: 2, formulae: [`$K2="At risk - failing"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } }, font: { color: { argb: C.failText } } } },
      { type: "expression", priority: 3, formulae: [`$K2="No test case"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.blocked } }, font: { color: { argb: C.blockedText } } } },
    ],
  });

  // ── Summary
  wsSum.getColumn(1).width = 34;
  for (let i = 2; i <= 12; i++) wsSum.getColumn(i).width = 11;
  title(wsSum, "A1", "Test summary - test.gokesari.com");
  wsSum.getCell("A2").value = "Every number on this sheet is a formula over the Status columns of Test Cases, E2E Scenarios and Defect Log. Do not type here.";
  wsSum.getCell("A2").font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };

  // Overall KPIs
  section(wsSum, 4, "Overall progress (test cases)", 12);
  const inScope = nCases - nBy(cases, "Not Applicable");
  const kpi = [
    ["Total test cases", `COUNTA(${R("A")})`, nCases],
    ["In scope (total minus Not Applicable)", `B5-COUNTIF(${STATUS},"Not Applicable")`, inScope],
    ["Executed (Pass + Fail)", `COUNTIF(${STATUS},"Pass")+COUNTIF(${STATUS},"Fail")`, 0],
    ["Pass", `COUNTIF(${STATUS},"Pass")`, 0],
    ["Fail", `COUNTIF(${STATUS},"Fail")`, 0],
    ["Blocked", `COUNTIF(${STATUS},"Blocked")`, 0],
    ["Not Run", `B6-B7-B10`, inScope],
    ["Execution progress (Executed / In scope)", `IF(B6=0,0,B7/B6)`, 0],
    ["Pass rate (Pass / Executed)", `IF(B7=0,0,B8/B7)`, 0],
  ];
  kpi.forEach(([k, f, v], i) => {
    const r = 5 + i;
    kv(wsSum, r, k as string, { formula: f as string, result: v as number }, { span: 2 });
    if (i >= 7) wsSum.getCell(r, 2).numFmt = "0.0%";
    else wsSum.getCell(r, 2).numFmt = "#,##0";
    wsSum.getCell(r, 2).font = { name: FONT, bold: true, size: 11 };
  });

  // By module
  let row = 16;
  section(wsSum, row, "By module", 12);
  row++;
  const modHead = ["Module", "Cases", "Pass", "Fail", "Blocked", "Not Applicable", "Not Run", "Executed %", "Pass %", "P0 cases", "P0 not passed", "Scenarios"];
  const modFirst = row + 1;
  grid(
    wsSum,
    row,
    modHead,
    modules.map((m, i) => {
      const r = modFirst + i;
      const mc = cases.filter((c) => c.module === m);
      const n = mc.length;
      const p0c = mc.filter((c) => c.priority === "P0");
      const p0 = p0c.length;
      return [
        m,
        { formula: `COUNTIF(${MOD},$A${r})`, result: n },
        { formula: `COUNTIFS(${MOD},$A${r},${STATUS},"Pass")`, result: 0 },
        { formula: `COUNTIFS(${MOD},$A${r},${STATUS},"Fail")`, result: 0 },
        { formula: `COUNTIFS(${MOD},$A${r},${STATUS},"Blocked")`, result: 0 },
        { formula: `COUNTIFS(${MOD},$A${r},${STATUS},"Not Applicable")`, result: nBy(mc, "Not Applicable") },
        { formula: `COUNTIFS(${MOD},$A${r},${STATUS},"Not Run")`, result: nBy(mc, "Not Run") },
        { formula: `IF(B${r}-F${r}=0,0,(C${r}+D${r})/(B${r}-F${r}))`, result: 0 },
        { formula: `IF(C${r}+D${r}=0,0,C${r}/(C${r}+D${r}))`, result: 0 },
        { formula: `COUNTIFS(${MOD},$A${r},${PRIO},"P0")`, result: p0 },
        { formula: `J${r}-COUNTIFS(${MOD},$A${r},${PRIO},"P0",${STATUS},"Pass")-COUNTIFS(${MOD},$A${r},${PRIO},"P0",${STATUS},"Not Applicable")`, result: p0 - nBy(p0c, "Pass") - nBy(p0c, "Not Applicable") },
        { formula: `COUNTIF('Test Scenarios'!$B$2:$B$${MAXROW},$A${r})`, result: scenarios.filter((s) => s.module === m).length },
      ];
    }),
  );
  const modLast = modFirst + modules.length - 1;
  const totRow = modLast + 1;
  wsSum.getCell(totRow, 1).value = "Total";
  for (let cI = 2; cI <= 12; cI++) {
    const L = colLetter(cI);
    const cell = wsSum.getCell(totRow, cI);
    if (L === "H") cell.value = { formula: `IF(B${totRow}-F${totRow}=0,0,(C${totRow}+D${totRow})/(B${totRow}-F${totRow}))`, result: 0 };
    else if (L === "I") cell.value = { formula: `IF(C${totRow}+D${totRow}=0,0,C${totRow}/(C${totRow}+D${totRow}))`, result: 0 };
    else {
      const p0all = cases.filter((c) => c.priority === "P0");
      const res = {
        B: nCases,
        C: nBy(cases, "Pass"),
        D: nBy(cases, "Fail"),
        E: nBy(cases, "Blocked"),
        F: nBy(cases, "Not Applicable"),
        G: nBy(cases, "Not Run"),
        J: p0all.length,
        K: p0all.length - nBy(p0all, "Pass") - nBy(p0all, "Not Applicable"),
        L: scenarios.length,
      }[L] ?? 0;
      cell.value = { formula: `SUM(${L}${modFirst}:${L}${modLast})`, result: res };
    }
  }
  for (let cI = 1; cI <= 12; cI++) {
    const cell = wsSum.getCell(totRow, cI);
    cell.font = { name: FONT, bold: true, size: 10 };
    cell.fill = fill(C.band);
    cell.border = thin;
  }
  for (let r = modFirst; r <= totRow; r++) {
    wsSum.getCell(r, 8).numFmt = "0%";
    wsSum.getCell(r, 9).numFmt = "0%";
    for (let cI = 2; cI <= 12; cI++) wsSum.getCell(r, cI).alignment = { horizontal: "center", vertical: "top" };
  }
  wsSum.addConditionalFormatting({
    ref: `H${modFirst}:I${modLast}`,
    rules: [{ type: "dataBar", priority: 1, minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }], color: { argb: "FF5B9BD5" } } as unknown as ExcelJS.ConditionalFormattingRule],
  });
  wsSum.addConditionalFormatting({
    ref: `D${modFirst}:D${modLast}`,
    rules: [{ type: "cellIs", operator: "greaterThan", priority: 2, formulae: ["0"], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } }, font: { color: { argb: C.failText }, bold: true } } }],
  });
  wsSum.addConditionalFormatting({
    ref: `K${modFirst}:K${modLast}`,
    rules: [{ type: "cellIs", operator: "greaterThan", priority: 3, formulae: ["0"], style: { font: { color: { argb: C.failText }, bold: true } } }],
  });
  // Defect Log module drop-down = this module list
  list(wsDef, `D2:D${DEFROWS + 1}`, `Summary!$A$${modFirst}:$A$${modLast}`);

  // By priority
  row = totRow + 2;
  section(wsSum, row, "By priority", 12);
  row++;
  const prFirst = row + 1;
  grid(
    wsSum,
    row,
    ["Priority", "Cases", "Pass", "Fail", "Blocked", "Not Applicable", "Not Run", "Executed %", "Pass %"],
    ["P0", "P1", "P2"].map((p, i) => {
      const r = prFirst + i;
      const pc = cases.filter((c) => c.priority === p);
      const n = pc.length;
      return [
        p,
        { formula: `COUNTIF(${PRIO},$A${r})`, result: n },
        { formula: `COUNTIFS(${PRIO},$A${r},${STATUS},"Pass")`, result: 0 },
        { formula: `COUNTIFS(${PRIO},$A${r},${STATUS},"Fail")`, result: 0 },
        { formula: `COUNTIFS(${PRIO},$A${r},${STATUS},"Blocked")`, result: 0 },
        { formula: `COUNTIFS(${PRIO},$A${r},${STATUS},"Not Applicable")`, result: nBy(pc, "Not Applicable") },
        { formula: `COUNTIFS(${PRIO},$A${r},${STATUS},"Not Run")`, result: nBy(pc, "Not Run") },
        { formula: `IF(B${r}-F${r}=0,0,(C${r}+D${r})/(B${r}-F${r}))`, result: 0 },
        { formula: `IF(C${r}+D${r}=0,0,C${r}/(C${r}+D${r}))`, result: 0 },
      ];
    }),
  );
  for (let r = prFirst; r < prFirst + 3; r++) {
    wsSum.getCell(r, 8).numFmt = "0%";
    wsSum.getCell(r, 9).numFmt = "0%";
    for (let cI = 2; cI <= 9; cI++) wsSum.getCell(r, cI).alignment = { horizontal: "center" };
  }

  // E2E scenarios
  row = prFirst + 4;
  section(wsSum, row, "End-to-end scenarios", 12);
  row++;
  const E2ES = `'E2E Scenarios'!$L$2:$L$500`;
  const e2eFirst = row + 1;
  grid(wsSum, row, ["Scenarios", "Pass", "Fail", "Blocked", "Not Applicable", "Not Run"], [
    [
      { formula: `COUNTA('E2E Scenarios'!$A$2:$A$500)`, result: nJ },
      { formula: `COUNTIF(${E2ES},"Pass")`, result: 0 },
      { formula: `COUNTIF(${E2ES},"Fail")`, result: 0 },
      { formula: `COUNTIF(${E2ES},"Blocked")`, result: 0 },
      { formula: `COUNTIF(${E2ES},"Not Applicable")`, result: journeys.filter((j) => j.status === "Not Applicable").length },
      { formula: `COUNTIF(${E2ES},"Not Run")`, result: journeys.filter((j) => (j.status ?? "Not Run") === "Not Run").length },
    ],
  ]);
  for (let cI = 1; cI <= 6; cI++) wsSum.getCell(e2eFirst, cI).alignment = { horizontal: "center" };

  // Defects by severity
  row = e2eFirst + 2;
  section(wsSum, row, "Defects (from Defect Log)", 12);
  row++;
  const DSEV = `'Defect Log'!$E$2:$E$${DEFROWS + 1}`;
  const DST = `'Defect Log'!$G$2:$G$${DEFROWS + 1}`;
  const defFirst = row + 1;
  const closedSet = `{"Closed","Deferred","Rejected","Duplicate"}`;
  grid(
    wsSum,
    row,
    ["Severity", "Logged", "Open (not Closed / Deferred / Rejected / Duplicate)", "Fixed - Ready for Retest", "Closed", "Deferred"],
    LISTS.Severity.map((s, i) => {
      const r = defFirst + i;
      return [
        s,
        { formula: `COUNTIF(${DSEV},$A${r})`, result: 0 },
        { formula: `B${r}-SUMPRODUCT(COUNTIFS(${DSEV},$A${r},${DST},${closedSet}))`, result: 0 },
        { formula: `COUNTIFS(${DSEV},$A${r},${DST},"Fixed - Ready for Retest")`, result: 0 },
        { formula: `COUNTIFS(${DSEV},$A${r},${DST},"Closed")`, result: 0 },
        { formula: `COUNTIFS(${DSEV},$A${r},${DST},"Deferred")`, result: 0 },
      ];
    }),
  );
  const defLast = defFirst + 3;
  wsSum.getCell(defLast + 1, 1).value = "Total";
  for (let cI = 2; cI <= 6; cI++) {
    const L = colLetter(cI);
    wsSum.getCell(defLast + 1, cI).value = { formula: `SUM(${L}${defFirst}:${L}${defLast})`, result: 0 };
  }
  for (let cI = 1; cI <= 6; cI++) {
    const c = wsSum.getCell(defLast + 1, cI);
    c.font = { name: FONT, bold: true, size: 10 };
    c.fill = fill(C.band);
    c.border = thin;
    for (let r = defFirst; r <= defLast + 1; r++) if (cI > 1) wsSum.getCell(r, cI).alignment = { horizontal: "center" };
  }
  wsSum.getRow(row).height = 30;

  // Exit criteria
  row = defLast + 3;
  section(wsSum, row, "Exit criteria (from Test Plan) - checked live", 12);
  row++;
  const exitFirst = row + 1;
  const p0r = prFirst; // P0 row in By priority
  const exit: Array<[string, string, string]> = [
    ["Every P0 test case executed (none Not Run or Blocked)", `IF(G${p0r}+E${p0r}=0,"Met","Not met")`, "Not met"],
    ["No P0 test case Failed", `IF(D${p0r}=0,"Met","Not met")`, "Met"],
    ["Overall pass rate of executed cases at least 95%", `IF(AND(B7>0,B13>=0.95),"Met","Not met")`, "Not met"],
    ["At least 90% of in-scope cases executed", `IF(B12>=0.9,"Met","Not met")`, "Not met"],
    ["No open S1 - Critical or S2 - Major defect", `IF(C${defFirst}+C${defFirst + 1}=0,"Met","Not met")`, "Met"],
    ["Every P0 end-to-end scenario passed", `IF(COUNTIFS('E2E Scenarios'!$D$2:$D$500,"P0",${E2ES},"<>Pass",'E2E Scenarios'!$A$2:$A$500,"<>")=0,"Met","Not met")`, "Not met"],
  ];
  grid(
    wsSum,
    row,
    ["Exit criterion", "Result"],
    exit.map(([k, f, v]) => [k, { formula: f, result: v }]),
  );
  wsSum.addConditionalFormatting({
    ref: `B${exitFirst}:B${exitFirst + exit.length - 1}`,
    rules: [
      { type: "expression", priority: 4, formulae: [`$B${exitFirst}="Met"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.pass } }, font: { color: { argb: C.passText }, bold: true } } },
      { type: "expression", priority: 5, formulae: [`$B${exitFirst}="Not met"`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: C.fail } }, font: { color: { argb: C.failText }, bold: true } } },
    ],
  });
  const exitAll = exitFirst + exit.length;
  kv(wsSum, exitAll, "All exit criteria met?", { formula: `IF(COUNTIF(B${exitFirst}:B${exitFirst + exit.length - 1},"Met")=${exit.length},"Yes","No")`, result: "No" }, { span: 2 });
  wsSum.getCell(exitAll, 2).font = { name: FONT, bold: true, size: 11 };
  wsSum.views = [{ state: "frozen", ySplit: 3, zoomScale: 90 }];

  // ── Cover
  wsCover.getColumn(1).width = 30;
  for (let i = 2; i <= 6; i++) wsCover.getColumn(i).width = 22;
  title(wsCover, "A1", "GoKesari - Manual Test Workbook", 20);
  wsCover.getCell("A2").value = "Test scenarios, test cases, execution results and evidence for test.gokesari.com";
  wsCover.getCell("A2").font = { name: FONT, size: 11, italic: true, color: { argb: "FF595959" } };
  section(wsCover, 4, "Document control (ISO/IEC/IEEE 29119-3)");
  const docRows: Array<[string, ExcelJS.CellValue, boolean?]> = [
    ["Document ID", `GK-QA-MTW-${DATE.replace(/-/g, "")}`],
    ["Document type", "Test specification and test execution record (manual)"],
    ["Version", `${REVISIONS.at(-1)?.version ?? "1.0"} (${fmtDate(REVISIONS.at(-1)?.date ?? DATE)})`, true],
    ["Status", "Draft - ready for Cycle 1", true],
    ["Prepared on", `${fmtDate(DATE)}, ${nowIst} IST`],
    ["Prepared by", "GoKesari QA (drafted with Claude Code)", true],
    ["Reviewed by", "", true],
    ["Approved by", "", true],
    ["Application under test", "GoKesari marketplace web app and PWA (customer, shop / Seller Central, rider, dealer, society, operator and admin portals)"],
    ["Test environment", "https://test.gokesari.com (staging, own VPS since 17-Nov-2026, Cashfree in sandbox / test mode)"],
    ["Build / release under test", "", true],
    ["Test cycle", "", true],
    ["Test period (from - to)", "", true],
    ["Standard followed", "ISO/IEC/IEEE 29119-3:2021 test documentation (successor of IEEE 829-2008); defect severity and test status per ISTQB glossary"],
    ["Source of the test cases", `tests/qa/catalog, exported from test-cases.xlsx: ${cases.length - newCases.length} cases and ${journeys.length - newJourneys.length} journeys of the 08-Nov-2026 plan plus ${newCases.length} cases and ${newJourneys.length} journeys added after it (Case origin = New, or Planned for features not built yet)`],
    ["Automated results shown for reference", `GOKESARI_MASTER_TEST_REGISTER.xlsx, as of ${regAsOf} - columns M-N of Test Cases. Manual results go in the amber columns.`],
  ];
  docRows.forEach(([k, v, input], i) => kv(wsCover, 5 + i, k, v, { input: !!input, height: String(v).length > 90 ? 30 : undefined }));
  let cr = 5 + docRows.length + 1;
  section(wsCover, cr, "Revision history");
  cr = grid(
    wsCover,
    cr + 1,
    ["Version", "Date", "Author", "Change", "", ""],
    [
      ...REVISIONS.map((r) => [r.version, fmtDate(r.date), "GoKesari QA", r.change, "", ""]),
      ["", "", "", "", "", ""],
      ["", "", "", "", "", ""],
    ],
    { inputCols: [0, 1, 2, 3] },
  );
  for (let r = cr - (REVISIONS.length + 2); r < cr; r++) wsCover.mergeCells(r, 4, r, 6);
  cr++;
  section(wsCover, cr, "What is in this workbook");
  const contents: Array<[string, string]> = [
    ["Cover", "Document control, revision history, contents."],
    ["How to use", "Legend (which cells to fill), status and severity definitions, evidence rules and naming, worked example rows."],
    ["Test Plan", "Scope, approach, environment, test accounts and data, entry / exit / suspension criteria, risks, roles, schedule."],
    ["Summary", "Live dashboard: progress and pass rate overall, by module, by priority; E2E; defects by severity; exit criteria check."],
    ["Test Scenarios", `${scenarios.length} test scenarios (test conditions) - what to test - each with its test cases and a live status.`],
    ["Test Cases", `${cases.length} test cases - how to test (steps, data, expected) - with the amber result and evidence columns to fill.`],
    ["E2E Scenarios", `${journeys.length} end-to-end journeys across roles, with result and evidence columns.`],
    ["Execution Log", "One row per execution, including re-runs and retests, so the history of each case is kept."],
    ["Evidence Register", "One row per evidence file (screenshot, recording, HAR, e-mail copy...) with a clickable link."],
    ["Defect Log", "Incident reports: severity, steps, expected / actual, evidence, fix reference and retest."],
    ["Traceability", "Requirements traceability matrix: feature -> scenarios -> test cases -> live coverage status."],
    ["Sign-off", "Test completion report: results, open risks, recommendation (Go / No-go) and approvals."],
    ["Lists", "Values behind the drop-downs."],
  ];
  cr = grid(wsCover, cr + 1, ["Sheet", "Purpose", "", "", "", ""], contents.map(([a, b]) => [a, b, "", "", "", ""]));
  for (let r = cr - contents.length; r < cr; r++) wsCover.mergeCells(r, 2, r, 6);

  // ── How to use
  wsHow.getColumn(1).width = 26;
  for (let i = 2; i <= 8; i++) wsHow.getColumn(i).width = 20;
  title(wsHow, "A1", "How to use this workbook");
  let hr = 3;
  section(wsHow, hr, "Legend", 8);
  hr++;
  const legend: Array<[string, string, string]> = [
    ["Amber header + light-yellow cells", C.input, "You fill these: Actual result, Status, Severity, Defect ID, Evidence, Browser / device, Build, Cycle, Tested by, Executed on, Remarks."],
    ["Navy header, white cells", C.white, "Test design - do not change during a run. Propose changes in Remarks."],
    ["Grey cells", C.ref, "Reference only: automation status and the latest automated result from the master register."],
    ["Green / red / amber / grey status", C.pass, "Set automatically from the Status value (Pass / Fail / Blocked / Not Applicable)."],
    ["Red-shaded Severity / Defect / Evidence cell", C.fail, "A required field is missing: a Fail needs Severity + Defect ID; a Fail or a P0 Pass needs an Evidence ID."],
  ];
  for (const [k, colour, v] of legend) {
    kv(wsHow, hr, k, v, { span: 8 });
    wsHow.getCell(hr, 1).fill = fill(colour === C.white ? C.band : colour);
    hr++;
  }
  hr++;
  section(wsHow, hr, "Steps for a test run", 8);
  hr++;
  const steps = [
    "1. Fill Cover: Build / release under test (the commit or PR on test.gokesari.com - see the footer or /api/health), Test cycle, Test period.",
    "2. Check the entry criteria on Test Plan. Run the Preflight & smoke cases (TC-PRE-*) first; if they fail, stop and log the defect (suspension criteria).",
    "3. Work module by module, P0 first, then P1, then P2, then the E2E Scenarios. Filter Test Cases by Module and Priority.",
    "4. For each case: follow the steps exactly, compare with Expected result, type what actually happened in Actual result and pick the Status.",
    "5. Capture evidence while testing (rules below), save the files in the Evidence folder, and add one row per file on Evidence Register. Put the Evidence ID(s) on the case row.",
    "6. On a Fail: add a row on Defect Log (next MD-number), then put the Defect ID and Severity on the case row.",
    "7. Add one row on Execution Log for every execution, including re-runs. The Test Cases row always shows the LATEST result.",
    "8. When a defect is fixed: retest, update the Defect Log row (Retest on / result / evidence) and the case row, and add an Execution Log row with Cycle = Retest.",
    "9. At the end of the cycle: read Summary (exit criteria), fill Sign-off, and save a dated copy of the workbook (…_<YYYY-MM-DD>.xlsx).",
  ];
  for (const s of steps) {
    wsHow.mergeCells(hr, 1, hr, 8);
    const c = wsHow.getCell(hr, 1);
    c.value = s;
    c.font = { name: FONT, size: 10 };
    c.alignment = { wrapText: true, vertical: "top" };
    wsHow.getRow(hr).height = s.length > 150 ? 28 : 16;
    hr++;
  }
  hr++;
  section(wsHow, hr, "Test status (Status column)", 8);
  hr++;
  hr = grid(wsHow, hr, ["Status", "Use it when", "", "", "", "", "", ""], [
    ["Not Run", "Not attempted yet (default)."],
    ["Pass", "The actual result matches the Expected result in full."],
    ["Fail", "Any difference from the Expected result. Needs Severity, Defect ID and evidence."],
    ["Blocked", "Cannot be executed: a precondition, account, data, provider or an earlier defect stops it. Say why in Actual result (and the blocking Defect ID if any)."],
    ["Not Applicable", "Out of scope for this build or environment (e.g. a production-only rule, a feature switched off on staging, or a Planned feature not built yet - those start as Not Applicable). Say why in Remarks."],
  ].map((r) => [...r, "", "", "", "", "", ""]));
  for (let r = hr - 5; r < hr; r++) wsHow.mergeCells(r, 2, r, 8);
  hr++;
  section(wsHow, hr, "Defect severity (impact) and priority (urgency)", 8);
  hr++;
  hr = grid(wsHow, hr, ["Severity", "Meaning", "", "", "", "", "", ""], [
    ["S1 - Critical", "Site or a core journey down (sign-in, order, pay, fulfil, deliver), money or data loss or wrong charge, security / privacy breach. No workaround. Stops release."],
    ["S2 - Major", "A main function fails or gives a wrong result (wrong total, wrong status, wrong person notified); a workaround exists but is not acceptable for customers."],
    ["S3 - Minor", "Function works with a limited defect; easy workaround (validation message missing, filter wrong, layout broken on one device)."],
    ["S4 - Trivial", "Cosmetic: text, spelling, alignment, colour, icon."],
    ["Priority P0 / P1 / P2", "Case priority from the plan: P0 = go-live blocker path (login, order, pay, fulfil, deliver, money, access control); P1 = important; P2 = secondary / edge. Defects take the same P0-P2 for fix urgency."],
  ].map((r) => [...r, "", "", "", "", "", ""]));
  for (let r = hr - 5; r < hr; r++) {
    wsHow.mergeCells(r, 2, r, 8);
    wsHow.getRow(r).height = 28;
  }
  hr++;
  section(wsHow, hr, "Evidence rules", 8);
  hr++;
  const evRules: Array<[string, string]> = [
    ["Minimum evidence", "Fail: screenshot of the actual result WITH the address bar visible, plus the console / network error if any; a screen recording for multi-step flows. P0 Pass: one screenshot of the final expected state. Blocked: a screenshot or note of the blocker. P1 / P2 Pass: optional (recommended)."],
    ["Money and payments", "Screenshot the order number, amount, payment status and the Cashfree SANDBOX page or the built-in test pay page (/orders/pay/sandbox/...). Never real cards, UPI IDs or bank accounts on staging."],
    ["Messages", "For e-mail / SMS / WhatsApp / push cases, a screenshot or copy of the message with its time stamp and sender."],
    ["Mask personal data", "Before saving, blur or crop OTP codes, full phone numbers, e-mail addresses, home addresses, PAN / GSTIN / Aadhaar, bank account numbers and tokens. Mark 'Personal data masked?' on Evidence Register."],
    ["Folder", "Keep evidence next to this workbook: Evidence/<YYYY-MM-DD>_<Cycle>/<TC-ID>/  e.g.  Evidence/2026-11-21_Cycle-1/TC-CART-009/"],
    ["File name / Evidence ID", "EV-<TC-ID>-<nn>_<what>.<ext>  e.g.  EV-TC-CART-009-01_wallet-debited.png  (Evidence ID = the part before the underscore: EV-TC-CART-009-01)."],
    ["Link", "Type the relative path in 'Evidence link' (Test Cases) or 'Location / link' (Evidence Register); the Open column makes it clickable. A shared-drive URL also works."],
    ["Dates and times", "Dates as DD-Mmm-YYYY (21-Nov-2026); times in IST as hh.mm (14.35 IST)."],
    ["Defect IDs", "Manual-run defects: MD-001, MD-002 ... If it is the same as an automated-suite defect (docs/testing/qa-defects.json, D-nnn), write that D-number in Remarks."],
  ];
  for (const [k, v] of evRules) {
    kv(wsHow, hr, k, v, { span: 8, height: v.length > 160 ? 42 : v.length > 90 ? 28 : 16 });
    hr++;
  }
  hr++;
  section(wsHow, hr, "Worked example - how filled rows look (examples only; the real sheets start empty)", 8);
  hr++;
  hr = grid(wsHow, hr, ["Sheet", "Field 1", "Field 2", "Field 3", "Field 4", "Field 5", "Field 6", "Field 7"], [
    ["Test Cases (amber part)", "Actual result: Order DB-…-X7 CONFIRMED; wallet ₹500.00 → ₹430.00", "Status: Pass", "Evidence ID(s): EV-TC-CART-009-01", "Evidence link: Evidence/2026-11-21_Cycle-1/TC-CART-009/EV-TC-CART-009-01_wallet-debited.png", "Browser / device: Chrome - Android phone", "Build: staging 90830e82; Cycle 1", "Tested by / on: A. Tester, 21-Nov-2026"],
    ["Test Cases (a Fail)", "Actual result: Total shows ₹0 after coupon; order placed at ₹0", "Status: Fail", "Severity: S1 - Critical; Defect ID: MD-001", "Evidence ID(s): EV-TC-CART-014-01, EV-TC-CART-014-02", "Browser / device: Safari - iPhone", "Build: staging 90830e82; Cycle 1", "Remarks: repeatable 3/3"],
    ["Evidence Register", "EV-TC-CART-009-01", "TC-CART-009; Exec EX-0007", "Screenshot", "EV-TC-CART-009-01_wallet-debited.png", "Evidence/2026-11-21_Cycle-1/TC-CART-009/…", "Shows order confirmed + wallet balance after", "Masked: Yes"],
    ["Defect Log", "MD-001  Coupon makes the order total ₹0", "TC-CART-014; Cart & checkout", "S1 - Critical; P0; New", "test.gokesari.com/cart; build 90830e82; Safari - iPhone", "Steps: 1. Add Cow Milk ×2 2. Apply coupon TEN10 3. Pay", "Expected ₹126.00 / Actual ₹0.00", "Evidence EV-TC-CART-014-01"],
    ["Execution Log", "EX-0007", "Cycle 1; 21-Nov-2026", "TC-CART-009", "test.gokesari.com (staging)", "Chrome - Android phone", "Pass", "EV-TC-CART-009-01"],
  ], {});
  for (let r = hr - 5; r < hr; r++) wsHow.getRow(r).height = 54;

  // ── Test Plan
  wsPlan.getColumn(1).width = 28;
  for (let i = 2; i <= 6; i++) wsPlan.getColumn(i).width = 26;
  title(wsPlan, "A1", "Test plan (summary) - test.gokesari.com");
  wsPlan.getCell("A2").value = "ISO/IEC/IEEE 29119-3 test plan items in short form. Amber-yellow cells are to be confirmed for each cycle.";
  wsPlan.getCell("A2").font = { name: FONT, italic: true, size: 9, color: { argb: "FF595959" } };
  let pr = 4;
  section(wsPlan, pr, "1. Context and scope");
  pr++;
  const scope: Array<[string, string, boolean?]> = [
    ["Objective", "Confirm by hand that every built GoKesari function works on test.gokesari.com before it is promoted to gokesari.com, and record each result with evidence."],
    ["Test items", "Web app and PWA at https://test.gokesari.com: storefront, search and price comparison, cart and checkout, wallet and Cashfree sandbox payments, orders, shop portal (Seller Central, product setup, billing, fulfilment), rider / gig worker portal and payouts, dealer portal, society module, subscriptions, returns and support, notifications, operator and admin consoles, PWA / Android app install and updates."],
    ["In scope", `All ${modules.length} modules on the Summary sheet; ${cases.length} test cases; ${journeys.length} end-to-end scenarios. Functional, negative, boundary, field validation, role / access security, responsive (desktop + phone) and regression.`],
    ["Out of scope", "Load / performance (tests/Load_Testing), penetration testing, real-money payments, production data changes, third-party provider internals (Cashfree, Sandbox.co.in, SMS / WhatsApp gateways) beyond our integration, and other projects."],
    ["Production (gokesari.com)", "Only read-only guest checks (Preflight & smoke and guest pages) after a release, by the post-deploy check and the automated guest suite. No test accounts, no sandbox payments, no test data on production."],
    ["Planned / under-build features", `${cases.filter((c) => (c.origin ?? "").startsWith("Planned")).length} cases and ${journeys.filter((j) => (j.origin ?? "").startsWith("Planned")).length} journeys are for features not on staging yet (onboarding Wave 2 / 3: WP6-WP10; R3: D-130, D-136, D-138, D-141, D-144). They start as Not Applicable with the release in Remarks - set them to Not Run when the feature reaches test.gokesari.com. Dealer commission 3% (DT-23, PR #417) cases start as Not Run with a note: run them once PR #417 is on staging.`],
    ["Features not yet testable", "See test-cases.xlsx 'Not yet testable' (e.g. live tracking screen, QR pickup, radius widening, replacement instead of refund). Mark such cases Not Applicable, not Fail."],
  ];
  for (const [k, v] of scope) {
    kv(wsPlan, pr, k, v, { height: v.length > 220 ? 44 : v.length > 110 ? 30 : 16 });
    pr++;
  }
  pr++;
  section(wsPlan, pr, "2. Approach");
  pr++;
  const approach: Array<[string, string]> = [
    ["Test levels", "System test (each function through the UI) and end-to-end acceptance (journeys across customer, shop, rider, operator / admin)."],
    ["Test design", "Scenarios from features and workflows; cases by equivalence classes, boundary values (limits, amounts, quantities), state transitions (order, shop, gig, subscription, payment, issue states), decision tables (pricing, fees, commission) and role-based access."],
    ["Order of execution", "Preflight & smoke -> Login -> Access control -> Location -> Discovery -> Cart -> Wallet / payments -> Fulfilment -> Dispatch -> Delivery -> Order states -> the rest. P0 first within each module, then the E2E scenarios."],
    ["Manual vs automated", "The automated suite (tests/qa, master register) runs the same IDs. Manual testing focuses on: cases marked Manual or 'Not run (rule)' on staging, new cases (Case origin = New), visual / usability checks, phone layout, and every Fail or Pass (partial) in the register."],
    ["Retests", "Fixed defects awaiting retest are listed in Doc_GoKesari/Devlopment_Trackers/GOKESARI_OPEN_ITEMS_AND_RELEASE_PLAN_<date>.xlsx ('Fixed - awaiting retest'); re-run their cases (the Defect column of the master register names them) with Cycle = Retest."],
    ["Regression", "After each staging-queue merge, re-run the Preflight cases and the P0 cases of the modules the change touched; record them with Cycle = Regression."],
    ["Time-based cases", "OTP expiry, offer lapse, accept timeout, grace periods: shorten the rule in /admin/settings on staging only, then restore the default (write both values in Remarks)."],
  ];
  for (const [k, v] of approach) {
    kv(wsPlan, pr, k, v, { height: v.length > 180 ? 30 : v.length > 110 ? 30 : 16 });
    pr++;
  }
  pr++;
  section(wsPlan, pr, "3. Environment");
  pr++;
  pr = grid(wsPlan, pr, ["Item", "Value", "", "", "", ""], [
    ["URL", "https://test.gokesari.com (staging). Check the host in the address bar before every write.", "", "", "", ""],
    ["Hosting", "Own VPS (Mumbai) since 17-Nov-2026; deploys by gk-deploy through the staging queue.", "", "", "", ""],
    ["Payments", "Staging uses Cashfree in sandbox (test) mode - checkout and the shop fee open /orders/pay/session/... Only when PAYMENT_GATEWAY=SANDBOX does the built-in test page /orders/pay/sandbox/... open instead ('Pay (success)' / 'Fail' / 'Let it expire'). Note the gateway seen in Remarks.", "", "", "", ""],
    ["Desktop browsers", "Chrome (latest) on Windows / macOS - primary; Safari (macOS), Edge, Firefox - smoke of P0 only.", "", "", "", ""],
    ["Phones", "Chrome on Android (e.g. Pixel / Samsung, 360-412 px wide) - primary; Safari on iPhone - P0 smoke. GoKesari Android app (APK) for App install & updates.", "", "", "", ""],
    ["Build under test", "", "", "", "", ""],
  ].map((r) => r), { inputCols: [] });
  for (let r = pr - 6; r < pr; r++) {
    wsPlan.mergeCells(r, 2, r, 6);
    wsPlan.getRow(r).height = 28;
  }
  wsPlan.getCell(pr - 1, 2).fill = fill(C.input);
  pr++;
  section(wsPlan, pr, "4. Test accounts (staging) - sign in with the e-mailed code; no passwords are kept here");
  pr++;
  pr = grid(wsPlan, pr, ["Role", "Account (key in tests/qa/worlds/staging.json)", "Used for", "", "", ""], [
    ["Customer 1", "customer", "Ordering, wallet, subscriptions, returns, referrals"],
    ["Customer 2", "customer2", "Second customer: access control (IDOR), serviceability"],
    ["Shop owner (Shop A)", "shop - E2E Four Features Bakery, PIN 411005", "Fulfilment, catalogue, pricing, billing, settlement"],
    ["Shop B", "shopB - Asmy test2, PIN 411005", "Price comparison, multi-shop cart"],
    ["Rider 1 / Rider 2", "rider / rider2", "Dispatch, delivery, gig payouts"],
    ["Admin", "admin", "Admin console, settings, verification, finance"],
    ["Operator / Operator (limited)", "ops / oplim", "Operations console, role limits"],
    ["New sign-ups", "Fresh inbox aliases and a test mobile per run", "Registration, onboarding, referral"],
  ].map((r) => [...r, "", "", ""]));
  for (let r = pr - 8; r < pr; r++) wsPlan.mergeCells(r, 3, r, 6);
  pr++;
  section(wsPlan, pr, "5. Test data");
  pr++;
  const data: Array<[string, string]> = [
    ["Cashfree sandbox (staging only)", "Cards: OTP 111000 for every test card; Visa 4111 1111 1111 1111 (exp 12/30, CVV 123); debit 4706 1312 1121 2123. UPI: testsuccess@gocash / testfailure@gocash. Net banking: bank code 3003. Full list: docs/testing/cashfree-sandbox-test-data.md."],
    ["Shop registration fee", "If the fee opens the built-in test page /orders/pay/sandbox/..., use 'Pay (success)' (no card or UPI details entered). If it opens Cashfree sandbox, use UPI testsuccess@gocash (or testfailure@gocash for the failure case)."],
    ["Catalogue", "Shop A listings: Cow Milk ₹70 (stock 500), Buffalo Ghee ₹650 (30), Chocolate Pastry ₹35 (stock 2 - low stock), Butter Cookies ₹60 (98)."],
    ["Files", "Product Excel template (download in the test) plus bad variants: missing mandatory column, Selling > MRP, text in a number column, negative stock, duplicate row. Images: normal JPG, 6 MB image, PDF renamed .jpg, 20x20 px. KYC: sample GST / PAN / FSSAI / Shop Act PDFs and an .exe renamed .pdf."],
    ["Identity / KYC", "Staging KYC uses the provider's test mode or test numbers agreed with the owner. Never type a real person's PAN / Aadhaar / bank account into staging."],
    ["Full list", "test-cases.xlsx sheet 'Test data' (accounts, seeds, coupons, slots, settings defaults)."],
  ];
  for (const [k, v] of data) {
    kv(wsPlan, pr, k, v, { height: v.length > 200 ? 44 : v.length > 100 ? 30 : 16 });
    pr++;
  }
  pr++;
  section(wsPlan, pr, "6. Entry, exit, suspension and resumption criteria");
  pr++;
  const crit: Array<[string, string]> = [
    ["Entry criteria", "Build deployed to staging by the staging queue and its post-deploy check passed; test.gokesari.com answers; TC-PRE-001..012 pass; test accounts can sign in; sandbox payments work; this workbook's Cover filled."],
    ["Exit criteria", "100% of P0 cases executed; no P0 case Failed; at least 90% of in-scope cases executed; pass rate of executed cases at least 95%; no open S1 / S2 defect; every P0 E2E scenario passed. Checked live on Summary."],
    ["Suspension", "Stop and log a defect when: the site is down or answers 5xx on core pages; sign-in fails for all roles; payments fail in sandbox; a deploy starts during the run; data looks corrupted."],
    ["Resumption", "The blocker is fixed and redeployed through the staging queue; re-run the Preflight cases, then continue where the run stopped (new Cycle if the build changed)."],
  ];
  for (const [k, v] of crit) {
    kv(wsPlan, pr, k, v, { height: v.length > 180 ? 30 : 28 });
    pr++;
  }
  pr++;
  section(wsPlan, pr, "7. Risks and mitigations");
  pr++;
  pr = grid(wsPlan, pr, ["Risk", "Impact", "Mitigation", "", "", ""], [
    ["Staging changes during a run (staging-queue merges)", "Results mix two builds", "Write Build on every row; check the post-deploy run before starting each day."],
    ["Sandbox / third-party provider down (Cashfree, KYC, SMS, maps)", "Cases Blocked", "Mark Blocked with the provider named; retry later; do not mark Fail."],
    ["Shared test accounts and shop data altered by other runs", "False fails", "Reset data per Test data; note the order / shop IDs used."],
    ["Personal data in evidence", "Privacy breach", "Mask before saving (How to use > Evidence rules)."],
    ["Time-based rules", "Long waits", "Shorten in /admin/settings on staging; restore defaults."],
  ].map((r) => [...r, "", "", ""]));
  for (let r = pr - 5; r < pr; r++) {
    wsPlan.mergeCells(r, 3, r, 6);
    wsPlan.getRow(r).height = 28;
  }
  pr++;
  section(wsPlan, pr, "8. Roles, deliverables and schedule");
  pr++;
  pr = grid(wsPlan, pr, ["Role / item", "Who / what", "", "", "", ""], [
    ["Test lead", ""],
    ["Testers", ""],
    ["Developers (fixes)", ""],
    ["Approver (Go / No-go)", "Owner"],
    ["Deliverables", "This workbook (results, evidence register, defect log, sign-off), the Evidence folder, and the dated copy saved in Doc_GoKesari/Test_Cases_Tracking."],
    ["Cycle 1 dates", ""],
    ["Retest / regression dates", ""],
  ].map((r) => [...r, "", "", "", ""]), { inputCols: [1] });
  for (let r = pr - 7; r < pr; r++) wsPlan.mergeCells(r, 2, r, 6);

  // ── Sign-off
  wsSign.getColumn(1).width = 34;
  for (let i = 2; i <= 6; i++) wsSign.getColumn(i).width = 20;
  title(wsSign, "A1", "Test completion report and sign-off");
  let sr = 3;
  section(wsSign, sr, "Run details");
  sr++;
  kv(wsSign, sr++, "Build / release tested", { formula: `IF(Cover!B15="","(fill on Cover)",Cover!B15)`, result: "(fill on Cover)" });
  kv(wsSign, sr++, "Test cycle", { formula: `IF(Cover!B16="","(fill on Cover)",Cover!B16)`, result: "(fill on Cover)" });
  kv(wsSign, sr++, "Test period", { formula: `IF(Cover!B17="","(fill on Cover)",Cover!B17)`, result: "(fill on Cover)" });
  sr++;
  section(wsSign, sr, "Results (from Summary)");
  sr++;
  const res: Array<[string, string, number | string, string?]> = [
    ["Test cases in scope", "Summary!B6", inScope],
    ["Executed (Pass + Fail)", "Summary!B7", 0],
    ["Pass", "Summary!B8", 0],
    ["Fail", "Summary!B9", 0],
    ["Blocked", "Summary!B10", 0],
    ["Not Run", "Summary!B11", inScope],
    ["Execution progress", "Summary!B12", 0, "0.0%"],
    ["Pass rate", "Summary!B13", 0, "0.0%"],
    ["E2E scenarios passed", `Summary!B${e2eFirst}`, 0],
    ["Open S1 / S2 defects", `Summary!C${defFirst}+Summary!C${defFirst + 1}`, 0],
    ["Defects logged (all)", `Summary!B${defLast + 1}`, 0],
    ["All exit criteria met?", `Summary!B${exitAll}`, "No"],
  ];
  for (const [k, f, v, fmt] of res) {
    kv(wsSign, sr, k, { formula: f, result: v });
    if (fmt) wsSign.getCell(sr, 2).numFmt = fmt;
    sr++;
  }
  sr++;
  section(wsSign, sr, "Assessment");
  sr++;
  for (const k of ["Summary of testing done", "Deviations from the plan", "Known open defects and workarounds", "Residual risks", "Lessons learned"]) {
    kv(wsSign, sr, k, "", { input: true, height: 44 });
    sr++;
  }
  kv(wsSign, sr, "Recommendation", "", { input: true });
  list(wsSign, `B${sr}`, listRef("Recommendation"));
  sr += 2;
  section(wsSign, sr, "Approvals");
  sr++;
  sr = grid(wsSign, sr, ["Role", "Name", "Decision", "Signature", "Date", "Comments"], [
    ["Test lead", "", "", "", "", ""],
    ["Development lead", "", "", "", "", ""],
    ["Owner / product owner", "", "", "", "", ""],
  ], { inputCols: [1, 2, 3, 4, 5] });
  for (let r = sr - 3; r < sr; r++) {
    wsSign.getRow(r).height = 30;
    wsSign.getCell(r, 5).numFmt = DATE_FMT;
  }
  list(wsSign, `C${sr - 3}:C${sr - 1}`, listRef("Recommendation"));

  // Print setup
  for (const ws of [wsTC, wsTS, wsE2E, wsDef, wsRtm, wsLog, wsEv])
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: "1:1" };
  for (const ws of [wsCover, wsHow, wsPlan, wsSum, wsSign]) ws.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };

  await wb.xlsx.writeFile(OUT);
  console.log(
    JSON.stringify({ out: OUT, scenarios: scenarios.length, cases: cases.length, newCases: newCases.length, newJourneys: newJourneys.length, e2e: journeys.length, features: rtmRows.length, modules: modules.length }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
