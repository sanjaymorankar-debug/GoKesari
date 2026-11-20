/**
 * GoKesari Health — PDF copy of a Markdown report (docs/health/TESTING_REPORT.md), screenshots embedded.
 *
 *   npx tsx scripts/health/report-pdf.ts docs/health/TESTING_REPORT.md docs/health/TESTING_REPORT.pdf
 *
 * A small Markdown subset (headings, paragraphs, lists, tables, bold, code, links, images) rendered with
 * Playwright's Chromium print-to-PDF — no extra dependency.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { chromium } from "@playwright/test";

const [input = "docs/health/TESTING_REPORT.md", output = input.replace(/\.md$/, ".pdf")] = process.argv.slice(2);
const base = dirname(resolve(input));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    try {
      const file = resolve(base, src);
      const type = extname(file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
      return `<img alt="${alt}" src="data:${type};base64,${readFileSync(file).toString("base64")}"/>`;
    } catch {
      return `[image: ${alt}]`;
    }
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

function render(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,4} /.test(line)) {
      const level = line.match(/^#+/)![0].length;
      html.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
      i++;
    } else if (line.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r: string) => r.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
      const [head, , ...body] = rows;
      html.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^\s*([-*]|\d+\.) /.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.) /, ""));
      html.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
    } else if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      html.push(`<pre>${esc(code.join("\n"))}</pre>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||```|\s*([-*]|\d+\.) )/.test(lines[i])) para.push(lines[i++]);
      html.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return html.join("\n");
}

async function main() {
  const body = render(readFileSync(input, "utf8"));
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", sans-serif; font-size: 9.5pt; color: #111; }
    h1 { font-size: 18pt; color: #c2410c; margin: 0 0 6pt; } h2 { font-size: 13pt; color: #9a3412; margin: 14pt 0 4pt; border-bottom: 1px solid #f0d9c8; }
    h3 { font-size: 11pt; margin: 10pt 0 3pt; } table { border-collapse: collapse; width: 100%; margin: 4pt 0 8pt; page-break-inside: auto; }
    th, td { border: 0.5pt solid #ccc; padding: 2.5pt 4pt; text-align: left; vertical-align: top; font-size: 8.5pt; } th { background: #fdf2e9; }
    tr { page-break-inside: avoid; } code { font-family: Menlo, monospace; font-size: 8pt; background: #f5f5f5; padding: 0 2pt; }
    pre { background: #f5f5f5; padding: 6pt; font-size: 8pt; white-space: pre-wrap; } img { max-width: 48%; border: 0.5pt solid #ddd; margin: 3pt; vertical-align: top; }
  </style></head><body>${body}</body></html>`;
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.setContent(page, { waitUntil: "load" });
  const pdf = await p.pdf({ format: "A4", margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" }, printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-size:7pt;width:100%;text-align:center;color:#888">GoKesari Health — testing report — page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' });
  writeFileSync(output, pdf);
  await browser.close();
  console.log(`${output}: ${Math.round(pdf.length / 1024)} KB`);
}

void main();
