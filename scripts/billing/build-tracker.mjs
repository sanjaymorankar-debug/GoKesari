// Builds the billing v2 tracker workbook from docs/billing/tracker-data.json.
//   node scripts/billing/build-tracker.mjs <out.xlsx> [<another out.xlsx> ...]
// One row per feature of the build prompt (and per gap G1–G17), with the
// columns the prompt's §15 asks for. Edit the JSON as features move, then rerun.
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

const data = JSON.parse(readFileSync(new URL("../../docs/billing/tracker-data.json", import.meta.url), "utf8"));
const outs = process.argv.slice(2);
if (!outs.length) {
  console.error("Usage: node scripts/billing/build-tracker.mjs <out.xlsx> [...]");
  process.exit(2);
}

const STATUS_FILL = { Done: "FFC6EFCE", "In progress": "FFFFEB9C", Blocked: "FFFFC7CE", "Not started": "FFEDEDED" };
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Billing v2 tracker", { views: [{ state: "frozen", ySplit: 3 }] });
ws.addRow([`Billing v2 tracker — updated ${data.updated} — branch ${data.branch} — testing report ${data.testingReport}`]).font = { bold: true };
ws.addRow([]);
const columns = [
  ["ID", "id", 9], ["Feature", "feature", 60], ["Prompt §", "section", 10], ["Gap", "gap", 10], ["Status", "status", 13],
  ["Environment", "env", 12], ["Web", "web", 22], ["Android", "android", 14], ["iOS", "ios", 14], ["Test result", "test", 28], ["Notes / blockers", "notes", 60],
];
const header = ws.addRow(columns.map(([h]) => h));
header.font = { bold: true };
header.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } }));
columns.forEach(([, , w], i) => (ws.getColumn(i + 1).width = w));
for (const r of data.rows) {
  const row = ws.addRow(columns.map(([, k]) => r[k] ?? ""));
  row.alignment = { vertical: "top", wrapText: true };
  const fill = STATUS_FILL[r.status];
  if (fill) row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}
ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };

const gaps = wb.addWorksheet("Gaps G1–G17");
gaps.addRow(["Gap", "Tracker rows", "Statuses"]).font = { bold: true };
for (let g = 1; g <= 17; g += 1) {
  const id = `G${g}`;
  const rows = data.rows.filter((r) => r.gap.split(/,\s*/).includes(id));
  gaps.addRow([id, rows.map((r) => r.id).join(", "), [...new Set(rows.map((r) => r.status))].join(", ")]);
}
gaps.getColumn(2).width = 40;
gaps.getColumn(3).width = 40;

for (const out of outs) {
  await wb.xlsx.writeFile(out);
  console.log(`wrote ${out}`);
}
