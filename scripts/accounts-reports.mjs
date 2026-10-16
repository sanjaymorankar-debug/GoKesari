/**
 * Builds the Inventory & Accounting tracker and test-report workbooks
 * (docs/inventory-accounting-2026-10) from JSON inputs, and the dated product
 * status report (docs/gokesari-audit/GOKESARI_FEATURE_STATUS_REPORT_<date>.xlsx)
 * from the previous one plus this module's rows.
 *
 *   node scripts/accounts-reports.mjs <features.json> <tests.json> <defects.json> <date> [<prev status report> <where-it-runs>]
 *
 * Without the last two arguments only the module's two workbooks are written
 * (when another release already wrote that day's status report, update it instead).
 */
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

const [featuresPath, testsPath, defectsPath, date, prevReport, whereRuns] = process.argv.slice(2);
const features = JSON.parse(readFileSync(featuresPath, "utf8"));
const tests = JSON.parse(readFileSync(testsPath, "utf8"));
const defects = JSON.parse(readFileSync(defectsPath, "utf8"));
const OUT = "docs/inventory-accounting-2026-10";
const head = (ws, cols) => {
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC2410C" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
};
const colour = { Done: "FFDCFCE7", "In progress": "FFFEF3C7", "Not started": "FFF1F5F9", Blocked: "FFFEE2E2", PASS: "FFDCFCE7", FAIL: "FFFEE2E2", BLOCKED: "FFFEF3C7", SKIPPED: "FFF1F5F9", "N/A": "FFF1F5F9" };
const paint = (cell) => {
  const c = colour[String(cell.value)];
  if (c) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c } };
};

/* ---------------------------------------------------------- module tracker */
{
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const sum = wb.addWorksheet("Summary");
  sum.getCell("A1").value = `Inventory & Accounting for shop owners — feature tracker (${date})`;
  sum.getCell("A1").font = { bold: true, size: 14 };
  sum.getCell("A2").value = "Status: Done / In progress / Not started / Blocked (dropdown in 'Features' column F). Counts below are formulas.";
  const statuses = ["Done", "In progress", "Not started", "Blocked"];
  sum.getCell("A4").value = "Status";
  sum.getCell("B4").value = "Features";
  sum.getRow(4).font = { bold: true };
  statuses.forEach((s, i) => {
    sum.getCell(`A${5 + i}`).value = s;
    sum.getCell(`B${5 + i}`).value = { formula: `COUNTIF(Features!$F$2:$F$500,A${5 + i})` };
    paint(sum.getCell(`A${5 + i}`));
  });
  sum.getCell("A9").value = "Total";
  sum.getCell("B9").value = { formula: "SUM(B5:B8)" };
  sum.getRow(9).font = { bold: true };
  const parts = [...new Set(features.map((f) => f[1]))];
  sum.getCell("A11").value = "Part";
  statuses.forEach((s, i) => (sum.getRow(11).getCell(2 + i).value = s));
  sum.getRow(11).font = { bold: true };
  parts.forEach((p, i) => {
    const r = 12 + i;
    sum.getCell(`A${r}`).value = p;
    statuses.forEach((s, j) => (sum.getRow(r).getCell(2 + j).value = { formula: `COUNTIFS(Features!$B$2:$B$500,$A${r},Features!$F$2:$F$500,"${s}")` }));
  });
  sum.getColumn(1).width = 36;
  const ws = wb.addWorksheet("Features");
  head(ws, [["ID", 9], ["Part", 18], ["Feature / sub-feature", 42], ["What it does", 70], ["Where it runs", 30], ["Status", 13], ["Notes / blocked on", 70]]);
  for (const [id, part, name, what, status, note] of features) {
    const row = ws.addRow([id, part, name, what, status === "Done" ? whereRuns : status === "Blocked" ? "Code on " + whereRuns + "; not switched on" : whereRuns, status, note]);
    row.alignment = { wrapText: true, vertical: "top" };
    paint(row.getCell(6));
    row.getCell(6).dataValidation = { type: "list", allowBlank: false, formulae: ['"Done,In progress,Not started,Blocked"'] };
  }
  const bl = wb.addWorksheet("Blocked & owner actions");
  head(bl, [["Feature", 10], ["What is needed", 80], ["Who", 14]]);
  for (const [id, , name, , status, note] of features) if (status === "Blocked" || status === "In progress") bl.addRow([id, `${name}: ${note}`, "Owner"]).alignment = { wrapText: true, vertical: "top" };
  await wb.xlsx.writeFile(`${OUT}/INVENTORY_ACCOUNTING_TRACKER_${date}.xlsx`);
}

/* ------------------------------------------------------------ test report */
{
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const sum = wb.addWorksheet("Summary");
  sum.getCell("A1").value = `Inventory & Accounting — testing report (${date})`;
  sum.getCell("A1").font = { bold: true, size: 14 };
  sum.getCell("A3").value = "Environment";
  ["PASS", "FAIL", "BLOCKED", "SKIPPED", "N/A", "Total"].forEach((h, i) => (sum.getRow(3).getCell(2 + i).value = h));
  sum.getRow(3).font = { bold: true };
  const envs = [...new Set(tests.map((t) => t.env))];
  envs.forEach((e, i) => {
    const r = 4 + i;
    sum.getCell(`A${r}`).value = e;
    ["PASS", "FAIL", "BLOCKED", "SKIPPED", "N/A"].forEach((s, j) => (sum.getRow(r).getCell(2 + j).value = { formula: `COUNTIFS('Test cases'!$C$2:$C$2000,$A${r},'Test cases'!$F$2:$F$2000,"${s}")` }));
    sum.getRow(r).getCell(7).value = { formula: `SUM(B${r}:F${r})` };
  });
  sum.getColumn(1).width = 44;
  const ws = wb.addWorksheet("Test cases");
  head(ws, [["ID", 16], ["Level", 12], ["Environment", 30], ["Test case", 64], ["Covers", 16], ["Result", 9], ["Detail / evidence", 80]]);
  for (const t of tests) {
    const row = ws.addRow([t.id, t.level, t.env, t.title, t.covers ?? "", t.result, t.detail ?? ""]);
    row.alignment = { wrapText: true, vertical: "top" };
    paint(row.getCell(6));
  }
  const ds = wb.addWorksheet("Defects & fixes");
  head(ds, [["#", 6], ["Found in", 26], ["Defect", 60], ["Fix", 60], ["Status", 10]]);
  defects.forEach((d, i) => ds.addRow([i + 1, d.found, d.defect, d.fix, d.status]).alignment = { wrapText: true, vertical: "top" });
  await wb.xlsx.writeFile(`${OUT}/INVENTORY_ACCOUNTING_TEST_REPORT_${date}.xlsx`);
}

/* ------------------------------------------- dated product status report */
if (prevReport) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(prevReport);
  const fr = wb.getWorksheet("Feature Register");
  const lastOld = fr.rowCount;
  const section = "Inventory & Accounting (15 Oct)";
  const map = { Done: "COMPLETED", "In progress": "IN PROGRESS", "Not started": "YET TO START", Blocked: "BLOCKED" };
  let n = fr.getRow(lastOld).getCell(1).value ?? lastOld - 1;
  for (const [id, part, name, what, status, note] of features) {
    n = Number(n) + 1;
    const row = fr.addRow([n, section, id, `Inventory & Accounting — ${part}`, name, what, "-", "P1", map[status], status === "Done" ? whereRuns : whereRuns, status === "Done" ? "Live" : "Code shipped; needs setup", "#171", whereRuns.includes("gokesari.com") && !whereRuns.includes("test") ? "#171 release" : "-", note || "-", status === "Blocked" ? note : "-", "Not tracked", "New (docs/inventory-accounting-2026-10)", "src/server/accounts; src/lib/accounts; docs/inventory-accounting-2026-10/README.md"]);
    row.getCell(9).dataValidation = { type: "list", allowBlank: false, formulae: ['"COMPLETED,IN PROGRESS,YET TO START,BLOCKED"'] };
  }
  const lastNew = fr.rowCount;
  const sum = wb.getWorksheet("Summary");
  // Every range that ended at the old last row now ends at the new one.
  sum.eachRow((row) =>
    row.eachCell((cell) => {
      const v = cell.value;
      if (v && typeof v === "object" && "formula" in v && v.formula.includes(`$${lastOld}`)) cell.value = { formula: v.formula.replaceAll(`$${lastOld}`, `$${lastNew}`) };
    }),
  );
  // Section table: the new section in row 33, the total moves to 34.
  const tmpl = sum.getRow(32);
  const total = sum.getRow(33);
  const totalValues = total.values;
  for (let c = 2; c <= 8; c += 1) {
    const v = tmpl.getCell(c).value;
    if (v && typeof v === "object" && "formula" in v) sum.getRow(33).getCell(c).value = { formula: v.formula.replaceAll("$A32", "$A33").replace(/([A-H])32\b/g, (_m, col) => `${col}33`) };
  }
  sum.getRow(33).getCell(1).value = section;
  for (let c = 1; c <= 8; c += 1) {
    const v = totalValues[c];
    sum.getRow(34).getCell(c).value = v && typeof v === "object" && "formula" in v ? { formula: v.formula.replace(/17:([A-H])32/g, (_m, col) => `17:${col}33`) } : v;
    sum.getRow(34).getCell(c).style = total.getCell(c).style;
  }
  sum.getRow(34).font = { bold: true };
  sum.getCell("A2").value = `As of ${date}. Adds the Inventory & Accounting module (PR #171, ${features.length} features/sub-features, section "${section}") to the 14 Oct report; nothing else re-assessed.`;
  await wb.xlsx.writeFile(`docs/gokesari-audit/GOKESARI_FEATURE_STATUS_REPORT_${date}.xlsx`);
}
console.log("written");
