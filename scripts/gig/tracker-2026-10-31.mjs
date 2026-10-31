/**
 * Gig worker flow: writes GOKESARI_FEATURE_STATUS_REPORT_2026-10-31.xlsx — the
 * 29 Oct report with the 11 gig worker features (GW-01..GW-11) added to the
 * Feature Register and PR #306 to the PR Register. Statuses come from
 * scripts/gig/tracker-status.json so the run can be repeated as the release moves.
 *
 *   node scripts/gig/tracker-2026-10-31.mjs <in.xlsx> <out.xlsx> [<more out.xlsx>…]
 */
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

const [input, ...outputs] = process.argv.slice(2);
const status = JSON.parse(readFileSync(new URL("./tracker-status.json", import.meta.url), "utf8"));

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(input);
const imagesBefore = wb.worksheets.reduce((n, ws) => n + ws.getImages().length, 0);

const fr = wb.getWorksheet("Feature Register");
const style = fr.getRow(fr.rowCount);
let n = Number(fr.getRow(fr.rowCount).getCell(1).value) || fr.rowCount - 1;
for (const f of status.features) {
  n += 1;
  const row = fr.addRow([
    n,
    "Gig worker flow (31 Oct 2026)",
    f.id,
    "Delivery partners",
    f.feature,
    f.functionality,
    "-",
    "P0",
    f.status,
    f.whereItRuns,
    f.switchedOn,
    { text: "#306", hyperlink: "https://github.com/sanjaymorankar-debug/GoKesari/pull/306" },
    f.releasedIn,
    f.remaining,
    f.next,
    "NEW (not in 29 Oct)",
    "Added 31 Oct 2026",
    f.evidence,
  ]);
  row.eachCell((cell, col) => {
    cell.style = { ...style.getCell(col).style };
  });
}

const pr = wb.getWorksheet("PR Register");
const prStyle = pr.getRow(pr.rowCount);
for (const p of status.prs) {
  const row = pr.addRow([
    { text: String(p.number), hyperlink: `https://github.com/sanjaymorankar-debug/GoKesari/pull/${p.number}` },
    p.title,
    p.type,
    p.branch,
    p.target,
    p.state,
    p.created,
    p.merged,
    p.features,
    p.released,
    p.releasedVia,
    p.notes,
  ]);
  row.eachCell((cell, col) => {
    cell.style = { ...prStyle.getCell(col).style };
  });
}

for (const out of outputs) await wb.xlsx.writeFile(out);
const check = new ExcelJS.Workbook();
await check.xlsx.readFile(outputs[0]);
const imagesAfter = check.worksheets.reduce((n, ws) => n + ws.getImages().length, 0);
console.log(`Feature Register: ${check.getWorksheet("Feature Register").rowCount} rows; images ${imagesBefore} -> ${imagesAfter}`);
if (imagesAfter !== imagesBefore) process.exitCode = 1;
