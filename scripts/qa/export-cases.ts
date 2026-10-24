/**
 * Exports the test plan (test-cases.xlsx: "Test cases" and "E2E scenarios")
 * to tests/qa/catalog/{cases,scenarios}.json, the form the QA specs, the
 * Claude QA agent and the master register read. Re-run after editing the
 * workbook; the JSON is committed so a run never depends on Excel.
 *
 *   npx tsx scripts/qa/export-cases.ts [test-cases.xlsx]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

const source = process.argv[2] ?? "test-cases.xlsx";
const out = join("tests", "qa", "catalog");

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("result" in value) return String(value.result ?? "");
    if ("text" in value) return String(value.text);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return String(value);
}

function rows(sheet: ExcelJS.Worksheet) {
  const header = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(text);
  const list: Record<string, string>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(text);
    if (!values[0]) return;
    list.push(Object.fromEntries(header.map((h, i) => [h, values[i] ?? ""])));
  });
  return list;
}

async function main() {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(source);
  const cases = rows(book.getWorksheet("Test cases")!).map((r) => ({
    id: r["TC ID"],
    module: r["Module"],
    features: r["Feature IDs"],
    title: r["Test case"],
    type: r["Type"],
    priority: r["Priority"],
    role: r["Role"],
    method: r["Method"],
    preconditions: r["Preconditions / data"],
    steps: r["Steps"],
    expected: r["Expected result"],
    source: r["Source (earlier plan / spec)"],
  }));
  const scenarios = rows(book.getWorksheet("E2E scenarios")!).map((r) => ({
    id: r["Scenario ID"],
    title: r["Scenario"],
    features: r["Workflows / features"],
    priority: r["Priority"],
    journey: r["Journey"],
    expected: r["Expected outcome"],
  }));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
  writeFileSync(join(out, "scenarios.json"), JSON.stringify(scenarios, null, 1) + "\n");
  console.log(`export-cases: ${cases.length} cases, ${scenarios.length} scenarios → ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
