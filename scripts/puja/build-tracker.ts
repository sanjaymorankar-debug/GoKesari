/**
 * Writes the Puja Samagri feature tracker workbook from docs/puja-samagri-2026-11/tracker.json
 * (every feature / sub-feature, its status, owner and each status change in IST).
 *   node --import tsx scripts/puja/build-tracker.ts [outFile.xlsx]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

type Change = { status: string; at: string; by: string };
type Item = { no: string; feature: string; group?: boolean; where?: string | null; owner?: string; history?: Change[] };

const ROOT = path.resolve(__dirname, "../..");
const data = JSON.parse(readFileSync(path.join(ROOT, "docs/puja-samagri-2026-11/tracker.json"), "utf8")) as { title: string; brief: string; pr: number; items: Item[] };
const out = process.argv[2] ?? path.join(ROOT, "docs/puja-samagri-2026-11/PUJA_SAMAGRI_TRACKER.xlsx");
const STATUSES = ["Not started", "In progress", "Dev done", "Tested on Test", "Deployed to Prod", "Tested on Prod", "Blocked"];
const FILL: Record<string, string> = {
  "Not started": "FFEDEDED", "In progress": "FFFFF2CC", "Dev done": "FFDDEBF7", "Tested on Test": "FFE2EFDA",
  "Deployed to Prod": "FFC6E0B4", "Tested on Prod": "FFA9D08E", Blocked: "FFF8CBAD",
};

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const ws = wb.addWorksheet("Tracker", { views: [{ state: "frozen", ySplit: 3 }] });
  ws.addRow([data.title]).font = { bold: true, size: 14 };
  ws.addRow([`Brief ${data.brief} · PR #${data.pr} · all times IST · statuses: ${STATUSES.join(" / ")}`]);
  const head = ws.addRow(["No.", "Feature / sub-feature", "Where", "Status", "Owner", "Status since (IST)", "Status history (IST)"]);
  head.font = { bold: true };
  for (const i of data.items) {
    if (i.group) {
      const r = ws.addRow([i.no, i.feature]);
      r.font = { bold: true };
      r.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
      continue;
    }
    const last = i.history?.[i.history.length - 1];
    const status = last?.status ?? "Not started";
    const r = ws.addRow([i.no, i.feature, i.where ?? "", status, i.owner ?? "", last?.at ?? "", (i.history ?? []).map((h) => `${h.at}: ${h.status} (${h.by})`).join("\n")]);
    r.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[status] ?? "FFFFFFFF" } };
    r.alignment = { wrapText: true, vertical: "top" };
  }
  [7, 70, 42, 16, 14, 22, 60].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const sum = wb.addWorksheet("Summary");
  sum.addRow(["Status", "Count"]).font = { bold: true };
  const rows = data.items.filter((i) => !i.group);
  for (const s of STATUSES) sum.addRow([s, rows.filter((i) => (i.history?.[i.history.length - 1]?.status ?? "Not started") === s).length]);
  sum.addRow(["Total", rows.length]);
  sum.getColumn(1).width = 20;
  await wb.xlsx.writeFile(out);
  console.log(`Wrote ${out} (${rows.length} items)`);
}

void main();
