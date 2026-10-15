/**
 * Bulk product upload functional run on a live site (docs/product-import-2026-10):
 * a signed-in session (signin.mjs) drives the real screens and the /api/v1
 * endpoints in Chromium, and every case is printed as one JSON line
 * {id, title, env, result, detail}. Screenshots go to <out dir>.
 *
 *   node scripts/test-site/product-import-check.mjs <base> <state.json> owner <out dir> <PUZZLES.xlsm>
 *   node scripts/test-site/product-import-check.mjs <base> <state.json> staff <out dir> <shopId>
 *   node scripts/test-site/product-import-check.mjs https://gokesari.com <state.json> smoke <out dir> <shopId> --prod-smoke
 *
 * owner  the full run on the owner's own active shop (test site only).
 * staff  an operator's or admin's run for <shopId> (test site only).
 * smoke  production smoke test: one 1-row import into the designated test
 *        shop <shopId>, its report, then a Delete file deactivating it again.
 *        The only mode allowed on gokesari.com, and only with --prod-smoke.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";
import ExcelJS from "exceljs";

const [base, statePath, mode, outDir, arg, flag] = process.argv.slice(2);
if (!base || !statePath || !mode || !outDir) {
  console.error("usage: product-import-check.mjs <base> <state.json> owner|staff|smoke <out dir> <PUZZLES.xlsm | shopId> [--prod-smoke]");
  process.exit(2);
}
const isProd = /\/\/(www\.)?gokesari\.com/.test(base);
if (isProd && !(mode === "smoke" && flag === "--prod-smoke")) {
  console.error("Refusing to write on production: only the smoke mode with --prod-smoke may run there.");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const ENV = new URL(base).host;
const RUN = Date.now().toString(36).toUpperCase();
const APP_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.1.0 (android)";

const results = [];
function record(id, title, result, detail = "") {
  const row = { id, title, env: ENV, result, detail: String(detail).slice(0, 700), at: new Date().toISOString() };
  results.push(row);
  console.log(JSON.stringify(row));
}
async function tcase(id, title, fn) {
  try {
    record(id, title, "PASS", (await fn()) ?? "");
  } catch (e) {
    record(id, title, "FAIL", e instanceof Error ? e.message : String(e));
  }
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** A sheet with one heading row (the GoKesari simple template's shape). */
async function sheet(file, headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  const p = path.join(outDir, file);
  writeFileSync(p, Buffer.from(await wb.xlsx.writeBuffer()));
  return p;
}

/** After "Completed" the result rows replace the preview rows on the next refresh (a few seconds). */
async function resultRows(p) {
  for (let i = 0; i < 40; i += 1) {
    const first = await p.locator('[data-testid="import-rows-table"] tbody tr').first().innerText().catch(() => "");
    if (first && !/\bready\b/.test(first)) return;
    await p.waitForTimeout(500);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const desktop = await browser.newContext({ storageState: statePath, viewport: { width: 1366, height: 900 }, acceptDownloads: true });
const page = await desktop.newPage();
page.setDefaultTimeout(120_000);
// "Import it again?" (a file imported before) is a confirm(): accept it as the user would.
page.on("dialog", (d) => void d.accept());
const api = desktop.request;

async function json(res) {
  const body = await res.json().catch(() => null);
  if (!res.ok()) throw new Error(`${res.status()} ${res.url()} ${JSON.stringify(body)?.slice(0, 300)}`);
  return body;
}
async function waitJob(jobId, statuses, timeoutMs = 15 * 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const job = await json(await api.get(`${base}/api/v1/product-imports/${jobId}`));
    if (statuses.includes(job.status) && (job.status !== "completed" || job.imagesStatus === "none" || job.imagesStatus === "done")) return job;
    if (job.status === "failed") throw new Error(`job failed: ${job.errorMessage}`);
    if (Date.now() > until) throw new Error(`timed out at ${job.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
/** Upload → preview → commit through the API (the same calls the screens and the apps make). */
async function importViaApi(shopId, file, inventoryMode = "SET") {
  const up = await json(
    await api.post(`${base}/api/v1/shops/${shopId}/product-imports`, {
      multipart: { file: { name: path.basename(file), mimeType: "application/octet-stream", buffer: readFileSync(file) } },
    }),
  );
  const preview = await waitJob(up.jobId, ["preview_ready"]);
  const rows = await json(await api.get(`${base}/api/v1/product-imports/${up.jobId}/rows?pageSize=200`));
  await json(await api.post(`${base}/api/v1/product-imports/${up.jobId}/commit`, { data: { inventoryMode } }));
  const done = await waitJob(up.jobId, ["completed"]);
  const after = await json(await api.get(`${base}/api/v1/product-imports/${up.jobId}/rows?pageSize=200`));
  return { jobId: up.jobId, preview, previewRows: rows.rows, done, rows: after.rows, duplicateOf: up.duplicateOf };
}
async function previewViaApi(shopId, file) {
  const up = await json(
    await api.post(`${base}/api/v1/shops/${shopId}/product-imports`, {
      multipart: { file: { name: path.basename(file), mimeType: "application/octet-stream", buffer: readFileSync(file) } },
    }),
  );
  await waitJob(up.jobId, ["preview_ready"]);
  const rows = await json(await api.get(`${base}/api/v1/product-imports/${up.jobId}/rows?pageSize=200`));
  return { jobId: up.jobId, rows: rows.rows, duplicateOf: up.duplicateOf };
}
async function uiWaitStatus(p, text, timeout = 15 * 60_000) {
  await p.locator('[data-testid="product-import-job"]').getByText(text, { exact: true }).first().waitFor({ timeout });
}

try {
  if (mode === "owner") {
    const puzzles = arg;
    let shopId = null;

    await tcase("PI-01", "Inventory menu has the Bulk upload (Excel/CSV) tile", async () => {
      await page.goto(`${base}/shop/inventory`);
      const link = page.locator('a[href="/shop/product-import"]').first();
      await link.waitFor();
      await page.screenshot({ path: path.join(outDir, "T01-inventory-tile.png") });
      return "link to /shop/product-import shown";
    });

    await tcase("PI-02", "Bulk upload page and the GoKesari template download", async () => {
      await page.goto(`${base}/shop/product-import`);
      await page.locator('[data-testid="product-import-upload"]').waitFor();
      await page.screenshot({ path: path.join(outDir, "T02-upload.png"), fullPage: true });
      const res = await api.get(`${base}/api/v1/product-imports/template`);
      check(res.ok(), `template ${res.status()}`);
      const cd = res.headers()["content-disposition"] ?? "";
      check(/GoKesari_Product_Upload_Template\.xlsx/.test(cd), cd);
      writeFileSync(path.join(outDir, "GoKesari_Product_Upload_Template.xlsx"), await res.body());
      return cd;
    });

    await tcase("PI-03", "Upload PUZZLES.xlsm in the browser: background check, preview of 5 rows, 309 columns, rows 6-7 left out", async () => {
      await page.setInputFiles('[data-testid="import-file-input"]', puzzles);
      await page.click('[data-testid="upload-button"]');
      await uiWaitStatus(page, "Ready to import");
      await page.locator('[data-testid="import-rows-table"] tbody tr').first().waitFor();
      await page.screenshot({ path: path.join(outDir, "T03-preview.png"), fullPage: true });
      const text = await page.locator('[data-testid="product-import-job"]').innerText();
      check(/309 columns/.test(text), "309 columns note missing");
      check(/rows: 6, 7/.test(text), "example/notice rows note missing");
      check(/macros/i.test(text), "macros note missing");
      return "preview shown";
    });

    await tcase("PI-04", "Only rows with warnings", async () => {
      await Promise.all([
        page.waitForResponse((r) => r.url().includes("/rows?status=warnings")),
        page.check('[data-testid="warnings-only"]'),
      ]);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, "T04-warnings-only.png"), fullPage: true });
      const n = await page.locator('[data-testid="import-rows-table"] tbody tr').count();
      check(n > 0, "no rows with warnings shown");
      return `${n} rows with warnings`;
    });

    await tcase("PI-05", "Import (Set stock to file quantity) completes with no failed row", async () => {
      await page.uncheck('[data-testid="warnings-only"]');
      await page.click('[data-testid="commit-button"]');
      await uiWaitStatus(page, "Completed");
      await resultRows(page);
      await page.screenshot({ path: path.join(outDir, "T05-result.png"), fullPage: true });
      const text = await page.locator('[data-testid="product-import-job"]').innerText();
      const failed = Number(/(\d+)\s*Failed/.exec(text)?.[1] ?? "NaN");
      check(failed === 0, `failed = ${failed}`);
      return text.split("\n").filter((l) => /^\d+$/.test(l.trim())).slice(0, 6).join(",");
    });

    await tcase("PI-06", "Result report download (Excel)", async () => {
      const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="report-xlsx"]')]);
      await download.saveAs(path.join(outDir, download.suggestedFilename()));
      check(/_result\.xlsx$/.test(download.suggestedFilename()), download.suggestedFilename());
      return download.suggestedFilename();
    });

    await tcase("PI-07", "The same file again: 'already imported' prompt", async () => {
      await page.click("text=Upload another file");
      await page.setInputFiles('[data-testid="import-file-input"]', puzzles);
      await page.click('[data-testid="upload-button"]');
      await uiWaitStatus(page, "Ready to import");
      const shown = await page.getByText("This file was already imported on").count();
      await page.screenshot({ path: path.join(outDir, "T06-duplicate.png") });
      check(shown > 0, "no duplicate prompt");
      await page.getByRole("button", { name: "Cancel" }).click();
      return "prompt shown, upload cancelled";
    });

    // The shop the page used (the owner's active shop) is read from a job of its history.
    await tcase("PI-08", "Import history (API)", async () => {
      await page.reload();
      await page.locator('[data-testid="product-import-history"] a[href*="/report"]').first().waitFor();
      const first = await page.locator('[data-testid="product-import-history"] a[href*="/report"]').first().getAttribute("href");
      const jobId = /product-imports\/([0-9a-f-]{36})\//.exec(first ?? "")?.[1];
      const job = await json(await api.get(`${base}/api/v1/product-imports/${jobId}`));
      shopId = job.shopId;
      const list = await json(await api.get(`${base}/api/v1/shops/${shopId}/product-imports`));
      check(list.imports.length >= 2, `imports ${list.imports.length}`);
      return `${list.imports.length} imports for shop ${shopId}`;
    });

    const skuA = `LIVE-${RUN}-A`;
    await tcase("PI-09", "GoKesari template file: new products, stock set to the file's Quantity", async () => {
      const file = await sheet(`gk-template-${RUN}.xlsx`, ["SKU", "Product Name", "Brand", "MRP", "Selling Price", "Quantity", "Unit", "Action"], [
        [skuA, `Live Test Product ${RUN} A`, "LiveBrand", 120, 99, 11, "pcs", "Upsert"],
        [`LIVE-${RUN}-B`, `Live Test Product ${RUN} B`, "LiveBrand", 60, 55, null, "pack", null],
        [null, `Live Test Product ${RUN} C`, null, null, null, 4, null, null],
      ]);
      const r = await importViaApi(shopId, file, "SET");
      check(r.preview.sourceFormat === "GOKESARI_TEMPLATE", r.preview.sourceFormat);
      check(r.done.counts.created === 3 && r.done.counts.failed === 0, JSON.stringify(r.done.counts));
      const c = r.rows.find((x) => x.rowNumber === 4);
      check(c.messages.some((m) => /SKU GK-[0-9A-F]{8}-\d{5} was generated/.test(m)), "no generated SKU");
      const b = r.rows.find((x) => x.rowNumber === 3);
      check(b.messages.some((m) => /not orderable until stock is set/.test(m)), "no blank-quantity warning");
      return JSON.stringify(r.done.counts);
    });

    await tcase("PI-10", "Stock: Set made it 11; Add adds 4 (15); the preview shows current → new", async () => {
      const add = await sheet(`add-${RUN}.xlsx`, ["SKU", "Quantity"], [[skuA, 4]]);
      const r = await importViaApi(shopId, add, "ADD");
      const before = r.previewRows[0].plan.currentQty;
      check(before === 11, `current before add = ${before}`);
      const check2 = await previewViaApi(shopId, await sheet(`check-${RUN}.xlsx`, ["SKU", "Quantity"], [[skuA, 1]]));
      const now = check2.rows[0].plan.currentQty;
      await json(await api.post(`${base}/api/v1/product-imports/${check2.jobId}/cancel`));
      check(now === 15, `stock after add = ${now}`);
      return "11 → 15";
    });

    await tcase("PI-11", "Blank and negative quantities leave stock unchanged; Edit with no match is skipped", async () => {
      const f = await sheet(`edge-${RUN}.xlsx`, ["SKU", "Quantity", "Action"], [[skuA, null, null], [`LIVE-${RUN}-B`, -3, null], [`NOPE-${RUN}`, 1, "Edit"]]);
      const r = await importViaApi(shopId, f, "SET");
      const [a, b, c] = r.rows;
      check(a.status === "updated", a.status);
      check(b.messages.some((m) => /negative; stock left unchanged/.test(m)), "no negative warning");
      check(c.status === "skipped", c.status);
      const p = await previewViaApi(shopId, await sheet(`check2-${RUN}.xlsx`, ["SKU", "Quantity"], [[skuA, 1]]));
      await json(await api.post(`${base}/api/v1/product-imports/${p.jobId}/cancel`));
      check(p.rows[0].plan.currentQty === 15, `stock = ${p.rows[0].plan.currentQty}`);
      return "stock still 15";
    });

    await tcase("PI-12", "Phone (Android app agent): preview as cards", async () => {
      const phone = await browser.newContext({ storageState: statePath, viewport: { width: 393, height: 851 }, userAgent: APP_UA, isMobile: true, hasTouch: true });
      const pp = await phone.newPage();
      pp.setDefaultTimeout(120_000);
      await pp.goto(`${base}/shop/product-import`);
      await pp.setInputFiles('[data-testid="import-file-input"]', await sheet(`phone-${RUN}.xlsx`, ["SKU", "Quantity"], [[skuA, 2]]));
      await pp.click('[data-testid="upload-button"]');
      await uiWaitStatus(pp, "Ready to import");
      await pp.locator('[data-testid="import-rows-cards"] li').first().waitFor();
      await pp.screenshot({ path: path.join(outDir, "T07-phone-preview.png"), fullPage: true });
      await pp.getByRole("button", { name: "Cancel" }).click();
      await phone.close();
      return "cards shown, cancelled";
    });

    await tcase("PI-13", "Delete action soft-deactivates (stock 0, listing kept)", async () => {
      const f = await sheet(`delete-${RUN}.xlsx`, ["SKU", "Action"], [[skuA, "Delete"], [`LIVE-${RUN}-B`, "Delete"]]);
      const r = await importViaApi(shopId, f, "SET");
      check(r.rows.every((x) => x.status === "deactivated"), r.rows.map((x) => x.status).join(","));
      return "2 deactivated";
    });

    await tcase("PI-14", "Owner notified in app when an import finishes", async () => {
      const body = await json(await api.get(`${base}/api/notifications`));
      const mine = body.notifications.filter((n) => n.type === "shop.product_import_finished");
      check(mine.length > 0, "no notification");
      return `${mine.length} × "${mine[0].title}": ${mine[0].body}`.slice(0, 300);
    });

    await tcase("PI-15", "Another shop's id is refused", async () => {
      const res = await api.get(`${base}/api/v1/shops/00000000-0000-4000-8000-000000000000/product-imports`);
      check([403, 404].includes(res.status()), String(res.status()));
      return String(res.status());
    });
    console.log(JSON.stringify({ shopId }));
  }

  if (mode === "staff") {
    const shopId = arg;
    await tcase("PS-01", "Bulk upload tile on the staff board", async () => {
      await page.goto(`${base}/admin`);
      await page.waitForLoadState("networkidle").catch(() => {});
      for (const hub of ["productMaster", "catalogue"]) {
        await page.goto(`${base}/admin/menu/${hub}`);
        if ((await page.locator('a[href="/admin/product-import"]').count()) > 0) {
          await page.screenshot({ path: path.join(outDir, `S01-${hub}-hub.png`), fullPage: true });
          return `tile on /admin/menu/${hub}`;
        }
      }
      throw new Error("no tile");
    });
    await tcase("PS-02", "Shop picker", async () => {
      await page.goto(`${base}/admin/product-import`);
      await page.locator('[data-testid="product-import-shop-picker"]').waitFor();
      await page.screenshot({ path: path.join(outDir, "S02-picker.png"), fullPage: true });
      return "picker shown";
    });
    await tcase("PS-03", "Import for the chosen shop in the browser", async () => {
      await page.goto(`${base}/admin/product-import?shopId=${shopId}`);
      const file = await sheet(`staff-${RUN}.xlsx`, ["SKU", "Product Name", "Selling Price", "Quantity"], [[`STAFF-${RUN}`, `Staff Upload ${RUN}`, 45, 6]]);
      await page.setInputFiles('[data-testid="import-file-input"]', file);
      await page.click('[data-testid="upload-button"]');
      await uiWaitStatus(page, "Ready to import");
      await page.click('[data-testid="commit-button"]');
      await uiWaitStatus(page, "Completed");
      await resultRows(page);
      await page.screenshot({ path: path.join(outDir, "S03-result.png"), fullPage: true });
      const text = await page.locator('[data-testid="product-import-job"]').innerText();
      return /sent to the shop owner for approval/.test(text) ? "created; price sent to the owner for approval" : "created; price applied at once";
    });
    await tcase("PS-04", "Clean up: Delete file deactivates the staff test product", async () => {
      const r = await importViaApi(shopId, await sheet(`staff-del-${RUN}.xlsx`, ["SKU", "Action"], [[`STAFF-${RUN}`, "Delete"]]));
      check(r.rows[0].status === "deactivated", r.rows[0].status);
      return "deactivated";
    });
  }

  if (mode === "smoke") {
    const shopId = arg;
    const sku = `SMOKE-${RUN}`;
    await tcase("PROD-01", "Bulk upload page loads", async () => {
      await page.goto(`${base}/admin/product-import?shopId=${shopId}`);
      await page.locator('[data-testid="product-import-upload"]').waitFor();
      await page.screenshot({ path: path.join(outDir, "P01-upload.png"), fullPage: true });
      return "ok";
    });
    let jobId = null;
    await tcase("PROD-02", "One-row import into the test shop; stock = file Quantity", async () => {
      const r = await importViaApi(shopId, await sheet(`smoke-${RUN}.xlsx`, ["SKU", "Product Name", "Selling Price", "Quantity"], [[sku, `Smoke Test ${RUN} (delete)`, 10, 3]]));
      jobId = r.jobId;
      check(r.done.counts.created === 1 && r.done.counts.failed === 0, JSON.stringify(r.done.counts));
      const p = await previewViaApi(shopId, await sheet(`smoke-check-${RUN}.xlsx`, ["SKU", "Quantity"], [[sku, 3]]));
      await json(await api.post(`${base}/api/v1/product-imports/${p.jobId}/cancel`));
      check(p.rows[0].plan.currentQty === 3, `stock = ${p.rows[0].plan.currentQty}`);
      return `job ${jobId}; stock 3`;
    });
    await tcase("PROD-03", "Result report", async () => {
      const res = await api.get(`${base}/api/v1/product-imports/${jobId}/report?format=csv`);
      check(res.ok(), String(res.status()));
      const text = (await res.body()).toString("utf8");
      writeFileSync(path.join(outDir, "smoke_result.csv"), text);
      check(text.includes(sku) && text.includes(",created,"), "report lacks the row");
      return "report has the row, status created";
    });
    await tcase("PROD-04", "Clean up: Delete file deactivates the smoke product", async () => {
      const r = await importViaApi(shopId, await sheet(`smoke-del-${RUN}.xlsx`, ["SKU", "Action"], [[sku, "Delete"]]));
      check(r.rows[0].status === "deactivated", r.rows[0].status);
      return "deactivated (hidden, stock 0)";
    });
  }
} finally {
  writeFileSync(path.join(outDir, `results-${mode}-${RUN}.json`), JSON.stringify(results, null, 2));
  await browser.close();
}
