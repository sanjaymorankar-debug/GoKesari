/**
 * GoKesari Health — product tracker workbook (owner's standard: Devlopment_Trackers, dated file).
 *
 *   npx tsx scripts/health/build-tracker.ts [--out <file.xlsx>] [--test <date IST>] [--prod <date IST>]
 *
 * Input: docs/health/features.json — one line per feature / sub-feature with status and, optionally,
 * testTest / testProd ("Pass" / "Fail" / "Not run"), deployedTest / deployedProd (IST) and notes.
 * Output: Feature tracker (feature × platform web / Android / iOS) + Summary with formula counts.
 */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

interface Feature {
  id: string;
  feature: string;
  sub: string;
  status: "Not started" | "In progress" | "Done" | "Blocked";
  testTest?: string;
  testProd?: string;
  deployedTest?: string;
  deployedProd?: string;
  notes?: string;
}

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const out = arg("--out") ?? `docs/health/GOKESARI_HEALTH_FEATURE_TRACKER_${today}.xlsx`;
const features = JSON.parse(readFileSync("docs/health/features.json", "utf8")) as Feature[];

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  wb.created = new Date();
  const ws = wb.addWorksheet("Feature tracker", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "ID", key: "id", width: 9 },
    { header: "Feature", key: "feature", width: 26 },
    { header: "Sub-feature", key: "sub", width: 70 },
    { header: "Platform", key: "platform", width: 10 },
    { header: "Status", key: "status", width: 13 },
    { header: "Test status — Test (test.gokesari.com)", key: "testTest", width: 18 },
    { header: "Test status — Prod (gokesari.com)", key: "testProd", width: 18 },
    { header: "Deployed on Test (IST)", key: "deployedTest", width: 20 },
    { header: "Deployed on Prod (IST)", key: "deployedProd", width: 20 },
    { header: "Notes", key: "notes", width: 60 },
  ];
  for (const f of features) {
    for (const platform of ["Web", "Android", "iOS"]) {
      ws.addRow({
        id: f.id,
        feature: f.feature,
        sub: f.sub,
        platform,
        status: f.status,
        testTest: f.testTest ?? "Not run",
        testProd: f.testProd ?? "Not run",
        deployedTest: f.deployedTest ?? "",
        deployedProd: f.deployedProd ?? "",
        notes: platform === "Web" ? (f.notes ?? "") : "Same screens in the app (WebView shell); app 1.10.0",
      });
    }
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC2410C" } };
  header.alignment = { wrapText: true, vertical: "middle" };
  ws.autoFilter = { from: "A1", to: "J1" };
  const fills: Record<string, string> = { Done: "FFDCFCE7", "In progress": "FFFEF3C7", Blocked: "FFFEE2E2", "Not started": "FFF3F4F6", Pass: "FFDCFCE7", Fail: "FFFEE2E2" };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.alignment = { wrapText: true, vertical: "top" };
    for (const col of [5, 6, 7]) {
      const v = String(row.getCell(col).value ?? "");
      if (fills[v]) row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fills[v] } };
    }
  });
  const last = ws.rowCount;
  const sum = wb.addWorksheet("Summary");
  sum.columns = [
    { header: "Measure", key: "m", width: 40 },
    { header: "Count", key: "c", width: 12 },
  ];
  const rows: [string, string][] = [
    ["Line items (feature × platform)", `COUNTA('Feature tracker'!A2:A${last})`],
    ["Done", `COUNTIF('Feature tracker'!E2:E${last},"Done")`],
    ["In progress", `COUNTIF('Feature tracker'!E2:E${last},"In progress")`],
    ["Blocked", `COUNTIF('Feature tracker'!E2:E${last},"Blocked")`],
    ["Not started", `COUNTIF('Feature tracker'!E2:E${last},"Not started")`],
    ["Passed on Test", `COUNTIF('Feature tracker'!F2:F${last},"Pass")`],
    ["Failed on Test", `COUNTIF('Feature tracker'!F2:F${last},"Fail")`],
    ["Passed on Prod", `COUNTIF('Feature tracker'!G2:G${last},"Pass")`],
  ];
  for (const [m, f] of rows) sum.addRow({ m, c: { formula: f } });
  sum.addRow({});
  sum.addRow({ m: `Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST from docs/health/features.json` });
  sum.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(out);
  console.log(`${features.length} features × 3 platforms → ${out}`);
}

void main();
