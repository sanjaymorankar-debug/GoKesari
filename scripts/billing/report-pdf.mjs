// Prints a billing Markdown report (headings, paragraphs, lists, tables,
// **bold**, `code`, [links](...)) to PDF with the Playwright Chromium the
// test suite already installs. Build prompt §13 asks for TESTING_REPORT as PDF.
//   node scripts/billing/report-pdf.mjs docs/billing/TESTING_REPORT.md <out.pdf>
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("Usage: node scripts/billing/report-pdf.mjs <report.md> <out.pdf>");
  process.exit(2);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

const lines = readFileSync(src, "utf8").split("\n");
const html = [];
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const h = /^(#{1,4})\s+(.*)$/.exec(line);
  if (h) {
    html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
  } else if (line.startsWith("|")) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
    i -= 1;
    const [head, , ...body] = rows;
    html.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`);
    for (const r of body) html.push(`<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
    html.push("</tbody></table>");
  } else if (/^\s*[-*]\s+/.test(line)) {
    html.push("<ul>");
    while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) html.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`);
    i -= 1;
    html.push("</ul>");
  } else if (line.trim()) {
    html.push(`<p>${inline(line)}</p>`);
  }
}

const page = `<!doctype html><meta charset="utf-8"><style>
  body { font: 10.5px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20px; color: #b34700; } h2 { font-size: 15px; margin-top: 18px; border-bottom: 1px solid #ddd; } h3 { font-size: 12.5px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; page-break-inside: auto; }
  th, td { border: 1px solid #ccc; padding: 3px 5px; vertical-align: top; text-align: left; }
  th { background: #f4ece4; } tr { page-break-inside: avoid; }
  code { font: 9.5px ui-monospace, Menlo, monospace; background: #f3f3f3; padding: 0 2px; }
</style>${html.join("\n")}`;

const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.setContent(page);
await tab.pdf({ path: out, format: "A4", landscape: true, margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" }, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;width:100%;text-align:center">GoKesari billing v2 — testing report — page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
await browser.close();
console.log(`wrote ${out}`);
