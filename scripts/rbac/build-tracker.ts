/**
 * docs/rbac: builds the RBAC v2 product tracker workbook (Development / Testing per server, IST).
 * Usage: npx tsx scripts/rbac/build-tracker.ts <out.xlsx>
 * The rows are the source of truth in docs/rbac/tracker.json; this only renders them.
 */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

interface Row {
  phase: string;
  feature: string;
  development: "Pending" | "In Progress" | "Completed";
  devAt: string;
  testServer: "Not Started" | "Passed" | "Failed" | "Blocked";
  testServerAt: string;
  production: "Not Started" | "Passed" | "Failed" | "Blocked";
  productionAt: string;
  flag: string;
  notes: string;
}

const out = process.argv[2];
if (!out) throw new Error("Usage: tsx scripts/rbac/build-tracker.ts <out.xlsx>");
const rows = JSON.parse(readFileSync(new URL("../../docs/rbac/tracker.json", import.meta.url), "utf8")) as Row[];

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("RBAC v2 tracker", { views: [{ state: "frozen", ySplit: 1 }] });
ws.columns = [
  { header: "Phase", key: "phase", width: 8 },
  { header: "Feature", key: "feature", width: 60 },
  { header: "Development", key: "development", width: 14 },
  { header: "Dev updated (IST)", key: "devAt", width: 20 },
  { header: "Testing — test.gokesari.com", key: "testServer", width: 18 },
  { header: "Test server run (IST)", key: "testServerAt", width: 20 },
  { header: "Testing — gokesari.com", key: "production", width: 18 },
  { header: "Production run (IST)", key: "productionAt", width: 20 },
  { header: "Done", key: "done", width: 8 },
  { header: "Flag", key: "flag", width: 28 },
  { header: "Notes", key: "notes", width: 70 },
];
ws.getRow(1).font = { bold: true };
for (const r of rows) {
  const done = r.development === "Completed" && r.testServer === "Passed" && r.production === "Passed" ? "Yes" : "No";
  const row = ws.addRow({ ...r, done });
  row.alignment = { vertical: "top", wrapText: true };
  const colour = (cell: ExcelJS.Cell, ok: boolean, bad: boolean) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ok ? "FFD9F2D9" : bad ? "FFF8D7DA" : "FFFFF3CD" } };
  };
  colour(row.getCell("development"), r.development === "Completed", false);
  colour(row.getCell("testServer"), r.testServer === "Passed", r.testServer === "Failed" || r.testServer === "Blocked");
  colour(row.getCell("production"), r.production === "Passed", r.production === "Failed" || r.production === "Blocked");
}
await wb.xlsx.writeFile(out);
console.log(`Wrote ${rows.length} rows to ${out}`);
