// Turns a dealer-programme Markdown report into a PDF (docs/dealer-programme, step 10):
//   node scripts/dealer-programme/report-pdf.mjs <in.md> <out.pdf>
// Handles the Markdown the reports use: headings, tables, lists, bold, code, links, rules.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: report-pdf.mjs <in.md> <out.pdf>");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

const lines = readFileSync(input, "utf8").split("\n");
const html = [];
let list = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  if (/^\|/.test(line)) {
    closeList();
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    i--;
    const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const [head, , ...body] = rows;
    html.push("<table><thead><tr>" + cells(head).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
    for (const r of body) html.push("<tr>" + cells(r).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
    html.push("</tbody></table>");
  } else if (/^#{1,3} /.test(line)) {
    closeList();
    const level = line.match(/^#+/)[0].length;
    html.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
  } else if (/^---\s*$/.test(line)) {
    closeList();
    html.push("<hr>");
  } else if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
    const kind = /^\s*\d+\. /.test(line) ? "ol" : "ul";
    if (list !== kind) {
      closeList();
      html.push(`<${kind}>`);
      list = kind;
    }
    let text = line.replace(/^\s*([-*]|\d+\.) /, "");
    // Continuation lines of the same item.
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1]) && !/^\s*([-*]|\d+\.) /.test(lines[i + 1])) text += " " + lines[++i].trim();
    html.push(`<li>${inline(text)}</li>`);
  } else if (line.trim() === "") {
    closeList();
  } else {
    closeList();
    let text = line;
    while (i + 1 < lines.length && lines[i + 1].trim() !== "" && !/^(\||#|---|\s*[-*] |\s*\d+\. )/.test(lines[i + 1])) text += " " + lines[++i].trim();
    html.push(`<p>${inline(text)}</p>`);
  }
}

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; font-size: 11px; line-height: 1.45; }
  h1 { color: #9a3412; font-size: 20px; margin: 0 0 6px; }
  h2 { color: #9a3412; font-size: 15px; margin: 18px 0 6px; }
  h3 { font-size: 12.5px; margin: 12px 0 4px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; }
  th, td { border: 1px solid #e5d9c7; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #fdf2e3; }
  code { background: #f5efe6; padding: 0 3px; border-radius: 3px; font-size: 10px; }
  hr { border: 0; border-top: 1px solid #e5d9c7; margin: 14px 0; }
  ul, ol { padding-left: 18px; margin: 4px 0; }
</style></head><body>${html.join("\n")}</body></html>`;

// The installed Chrome, so no Playwright browser download is needed.
const browser = await chromium.launch({ channel: "chrome" });
const tab = await browser.newPage();
await tab.setContent(page, { waitUntil: "load" });
await tab.pdf({ path: output, format: "A4", margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" }, printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#6b7280">GoKesari Dealer Programme — Testing Report · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
await browser.close();
console.log(`written ${output}`);
