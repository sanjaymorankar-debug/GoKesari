// Builds the Dealer Programme product tracker (docs/dealer-programme, step 10):
//   node scripts/dealer-programme/build-tracker.mjs <out.xlsx> [staging-results.json]
// staging-results.json (optional): { "<module id>": "PASS" | "FAIL" | "BLOCKED" | "PARTIAL", ... }
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

const [out, stagingFile] = process.argv.slice(2);
if (!out) throw new Error("usage: build-tracker.mjs <out.xlsx> [staging-results.json]");
const staging = stagingFile ? JSON.parse(readFileSync(stagingFile, "utf8")) : {};

// id, module, what it does, priority, step, migration, commit
const MODULES = [
  ["FLAGS", "Feature flags & geo areas", "Four flags, per district; Maharashtra districts, Pune talukas / localities, PIN prefixes; DEALER role", "P0", 1, "0101, 0102, 0103", "bc3f93a"],
  ["FEE-SLABS", "Registration fee slabs", "Admin-defined fee slabs by declared turnover (up to 20)", "P0", 1, "—", "973d520"],
  ["GKS-DR-001", "Dealer registration", "Application by type, mobile OTP, e-mail, documents per type, ₹1 bank check, agreement", "P0", 2, "0104", "3d92aaf"],
  ["GKS-DR-002", "Dealer documents & approval", "Configurable document requirements; admin approval queue; suspend / reject / terminate", "P0", 2, "0104", "3d92aaf"],
  ["GKS-DR-003", "Dealer codes, link & QR", "GKS-MH-<district>-code, share link /shop/register?ref=, QR, suspend / replace", "P0", 2, "0104", "3d92aaf"],
  ["GKS-DR-004", "Employees", "Salespeople with optional Employee ID; legacy distributors migrated as dealers", "P0", 2, "0104", "3d92aaf"],
  ["GKS-SH-001", "Self-registration attribution", "Code typed or from ?ref=, optional Employee ID field", "P0", 3, "0105", "611f979"],
  ["GKS-SH-002", "Dealer-assisted registration", "Dealer registers with the owner; owner confirms with a code", "P0", 3, "0105", "611f979"],
  ["GKS-SH-003", "Duplicates", "Phone / GSTIN / name within 150 m flagged; no commission", "P0", 3, "0105", "611f979"],
  ["GKS-RA-001", "Attribution & claims", "30-day leads (cap 200), attribution priority, dealer claims decided by staff", "P0", 3, "0105", "611f979"],
  ["GKS-SH-004", "Instant approval on GST/PAN + payment", "Government check + gateway fee → approved; ready-for-upload e-mail; evidence log; retry when source down", "P0", 4, "0106", "4500808, 6db91cd"],
  ["GKS-CM-001", "Commission rules", "Fixed / % / both, per shop type, district, milestone, versioned, admin only", "P0", 5, "0107", "22a74db"],
  ["GKS-CM-002", "Ledger & payouts", "Earned → approved → paid; cap with override; reversals; payouts with bank reference; CSV statement; hold for shops approved without documents", "P0", 5, "0107", "22a74db, 9e3e1b7"],
  ["GKS-CM-003", "Rating & bonus", "Rating 0–10 by live shops (slabs), start rating, downgrade, bonus", "P0", 5, "0107", "22a74db"],
  ["GKS-DB-001", "Dealer dashboard", "Tiles, pending, performance by day / week / month, employees, areas; admin dealer list", "P0", 6, "—", "89f66b9, c9ea939"],
  ["GKS-SP-001", "Support services", "General (free), product upload, price update; admin charges; wallet / online pay; tickets; refunds", "P0", 7, "0108", "c70e869"],
  ["GKS-GEO-001", "Coverage map & targets", "Areas with dealers, shops, operational, target vs registered, gaps; drawn map", "P1", 8, "0110", "bf53b23"],
  ["GKS-AN-001", "Performance score", "Weighted score (admin weights), ranked within district", "P1", 8, "—", "bf53b23"],
  ["GKS-AN-002", "Activation & 30-day activity", "Per dealer and employee", "P1", 8, "—", "bf53b23"],
  ["APP", "Mobile app parity", "Website in the app shell; app links; downloads and print through the bridge", "P0", 9, "—", "c89cf0b"],
  ["DOCS", "Guides & report", "Admin guide, dealer onboarding guide, testing report", "P0", 10, "—", "c9ea939"],
  ["GKS-IN-001", "All-India states & districts", "28 states + 8 UTs with PIN prefixes; districts added by admin with generated short codes", "P0", 11, "0114", "a8258f1, 5f134ad"],
  ["GKS-IN-002", "Add dealer (admin)", "Any state / district (or a new one); approved at once; code GKS-<state>-<district>-XXXXXX or GKS-<state>-XXXXXX", "P0", 11, "0114", "a8258f1"],
  ["GKS-IN-003", "Flags & commission by state", "Flags on for whole states or districts; commission rules for India / state / district (most specific wins)", "P0", 11, "—", "a8258f1"],
  ["VER-FIX", "PAN / GST / Udyam verification fixes", "PAN vs GSTIN's PAN in either order; reviewer approval survives re-check; reviewer row lock; state from any PIN; licence re-runs approval", "P0", 11, "—", "faac963"],
];

const wb = new ExcelJS.Workbook();
wb.creator = "GoKesari";
wb.created = new Date();
const ws = wb.addWorksheet("Dealer programme", { views: [{ state: "frozen", ySplit: 1 }] });
ws.columns = [
  { header: "ID", key: "id", width: 13 },
  { header: "Module", key: "module", width: 30 },
  { header: "What it does", key: "what", width: 70 },
  { header: "Priority", key: "priority", width: 9 },
  { header: "Build step", key: "step", width: 10 },
  { header: "Migration", key: "migration", width: 16 },
  { header: "Commit(s)", key: "commit", width: 18 },
  { header: "Built", key: "built", width: 9 },
  { header: "Local + CI tests", key: "ci", width: 15 },
  { header: "Staging (test.gokesari.com)", key: "staging", width: 24 },
  { header: "Production", key: "prod", width: 26 },
];
for (const [id, module, what, priority, step, migration, commit] of MODULES) {
  ws.addRow({ id, module, what, priority, step, migration, commit, built: "Done", ci: "PASS", staging: staging[id] ?? "Not run", prod: staging.__prod ?? "Not released (flags off)" });
}
const header = ws.getRow(1);
header.font = { bold: true, color: { argb: "FFFFFFFF" } };
header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB45309" } };
header.alignment = { vertical: "middle", wrapText: true };
const tone = { PASS: "FFDCFCE7", FAIL: "FFFEE2E2", BLOCKED: "FFFEF3C7", PARTIAL: "FFFEF3C7" };
ws.eachRow((row, n) => {
  row.alignment = { vertical: "top", wrapText: true };
  if (n === 1) return;
  for (const key of ["ci", "staging"]) {
    const cell = row.getCell(key);
    const fill = tone[String(cell.value).split(" ")[0]];
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
});
ws.autoFilter = { from: "A1", to: "K1" };

const flags = wb.addWorksheet("Feature flags");
flags.columns = [
  { header: "Flag", key: "flag", width: 40 },
  { header: "Switches on", key: "what", width: 60 },
  { header: "Staging", key: "staging", width: 22 },
  { header: "Production", key: "prod", width: 22 },
];
for (const [flag, what] of [
  ["dealer_programme_enabled", "Dealer application and portal, codes, attribution, commission, analytics"],
  ["gov_verification_auto_approval_enabled", "Instant approval on GST/PAN + gateway fee"],
  ["dealer_rating_bonus_enabled", "Rating bonus on commission"],
  ["paid_support_services_enabled", "Paid Support services page"],
]) {
  flags.addRow({ flag, what, staging: staging.__flags ?? "Off", prod: staging.__prodFlags ?? "Off" });
}
flags.getRow(1).font = { bold: true };

await wb.xlsx.writeFile(out);
console.log(`written ${out} (${MODULES.length} modules)`);
