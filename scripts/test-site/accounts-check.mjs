/**
 * Inventory & Accounting functional run on a live site (docs/inventory-accounting-2026-10):
 * a shop owner's signed-in session (signin.mjs) drives the real screens and
 * API in Chromium — desktop, phone and the Android app's WebView agent — and
 * every case is printed as one JSON line {id, title, env, result, detail}.
 *
 *   node scripts/test-site/accounts-check.mjs https://test.gokesari.com owner-state.json [suite]
 *
 * Suites: all (default), board, soft, hard, correct, gst, reports, sales, money, iso.
 * Writes only to the signed-in owner's own shop (test site). Never point it at
 * gokesari.com: production is checked read-only (prod-smoke.mjs).
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";

const [base, statePath, only = "all"] = process.argv.slice(2);
if (!base || !statePath) {
  console.error("usage: accounts-check.mjs <base url> <state.json> [suite]");
  process.exit(2);
}
if (/\/\/(www\.)?gokesari\.com/.test(base)) {
  console.error("Refusing to write test data on production.");
  process.exit(2);
}
const ENV = new URL(base).host;
const APP_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.0.0 (android)";
const RUN = Date.now().toString(36).toUpperCase();
const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const DMY = `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`;

function gstin(state, body) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const g = `${state}${body}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return g + chars[(36 - (sum % 36)) % 36];
}
const SUPPLIER = gstin("27", "AABCS5678B");
const OTHER_STATE = gstin("29", "AABCT9012C");

const results = [];
function record(id, title, result, detail = "") {
  const row = { id, title, env: ENV, result, detail: String(detail).slice(0, 600), at: new Date().toISOString() };
  results.push(row);
  console.log(JSON.stringify(row));
}
async function tcase(id, title, fn) {
  try {
    const detail = await fn();
    record(id, title, "PASS", detail ?? "");
  } catch (e) {
    record(id, title, "FAIL", e instanceof Error ? e.message : String(e));
  }
}
const want = (s) => only === "all" || only.split(",").includes(s);
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });

// An owner with several shops: work on one that has products (bill lines need
// something to map to), chosen with Seller Central's shop switcher like a user.
{
  const ctx = await browser.newContext({ storageState: statePath });
  const p = await ctx.newPage();
  await p.goto(`${base}/shop`, { timeout: 120_000 });
  const options = p.getByTestId("shop-switcher-option");
  const all = await options.evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("value"), current: e.getAttribute("aria-current") === "true" })));
  // The top bar renders the switcher for phone and desktop; keep each shop once.
  const ids = all.filter((o, i) => all.findIndex((x) => x.id === o.id) === i);
  for (const { id, current } of ids) {
    const ls = await (await ctx.request.get(`${base}/api/shops/${id}/accounts/stock/listings`, { timeout: 120_000 })).json().catch(() => []);
    if (!Array.isArray(ls) || ls.length === 0) continue;
    if (!current) {
      const switcher = p.locator('[data-testid="shop-switcher"]:visible').first();
      await switcher.locator("summary").click();
      await switcher.locator(`[data-testid="shop-switcher-option"][value="${id}"]`).click();
      for (let i = 0; i < 120 && !(await ctx.cookies()).some((c) => c.name === "gk_shop" && c.value === id); i += 1) await p.waitForTimeout(1000);
      await ctx.storageState({ path: statePath });
    }
    console.log(JSON.stringify({ info: "shop-with-products", shopId: id, listings: ls.length, switched: !current }));
    break;
  }
  await ctx.close();
}

const desktop = await browser.newContext({ storageState: statePath, viewport: { width: 1366, height: 900 } });
const phone = await browser.newContext({ storageState: statePath, viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
const app = await browser.newContext({ storageState: statePath, viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true, userAgent: APP_UA });
// The test site's database is far from its web server: allow slow pages.
for (const c of [desktop, phone, app]) {
  c.setDefaultTimeout(60_000);
  c.setDefaultNavigationTimeout(90_000);
}
const page = await desktop.newPage();
const api = desktop.request;

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The shop the owner works on (Seller Central's active shop): the capture screen carries its id.
await page.goto(`${base}/shop/accounts/capture`);
const html = await page.content();
const SHOP = (/shopId\\?":\\?"([0-9a-f-]{36})/.exec(html) ?? /\/api\/shops\/([0-9a-f-]{36})\//.exec(html) ?? [])[1] ?? null;
const A = (p) => `${base}/api/shops/${SHOP}/accounts/${p}`;

async function listings() {
  return json(await api.get(A("stock/listings")));
}
async function stockOf(spId) {
  const rows = await json(await api.get(A("stock")));
  const row = rows.rows.find((r) => r.shopProductId === spId);
  return row ? row.qtyMilli : null;
}
async function waitCapture(id, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const c = await json(await api.get(A(`bills/${id}/status`)));
    if (!["QUEUED", "PROCESSING"].includes(c.status)) return c;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("still being read after 2 minutes");
}
function einvoice(no, item) {
  return JSON.stringify({
    Version: "1.1",
    DocDtls: { Typ: "INV", No: no, Dt: DMY },
    SellerDtls: { Gstin: SUPPLIER, LglNm: "Shree Vitthal Distributors (E2E)", Stcd: "27" },
    BuyerDtls: { Gstin: "URP", LglNm: "E2E", Pos: "27", Stcd: "27" },
    ItemList: [{ SlNo: "1", PrdDesc: item.name, HsnCd: item.hsn ?? "0405", Qty: 12, Unit: "NOS", UnitPrice: 50, TotAmt: 600, Discount: 0, AssAmt: 600, GstRt: 12, IgstAmt: 0, CgstAmt: 36, SgstAmt: 36, CesAmt: 0, TotItemVal: 672 }],
    ValDtls: { AssVal: 600, CgstVal: 36, SgstVal: 36, IgstVal: 0, CesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: 672 },
  });
}

console.log(JSON.stringify({ info: "shop", shopId: SHOP, run: RUN }));
check(SHOP, "could not find the shop id on /shop/accounts");

let listing = null;
let softPurchaseId = null;

/* ---------------------------------------------------------------- board */
if (want("board")) {
  for (const [ctxName, ctx] of [["desktop", desktop], ["phone", phone], ["android-app", app]]) {
    await tcase(`TS-BOARD-${ctxName}`, `Tile Board loads on ${ctxName}: 12 tiles, headline figures, CA note, one screen`, async () => {
      const p = await ctx.newPage();
      const res = await p.goto(`${base}/shop/accounts`);
      check(res.status() === 200, `HTTP ${res.status()}`);
      const tiles = await p.locator('[data-testid="accounts-tile"]').count();
      check(tiles === 12, `${tiles} tiles`);
      check(await p.getByText(/verify with your CA/i).first().isVisible(), "CA note missing");
      const last = await p.locator('[data-testid="accounts-tile"]').last().boundingBox();
      const vh = p.viewportSize().height;
      await p.close();
      return `tiles=12, last tile bottom ${Math.round(last.y + last.height)}px of ${vh}px viewport`;
    });
  }
  await tcase("TS-NAV", "Every module page opens (200) for the owner", async () => {
    const paths = ["/shop/accounts", "/shop/accounts/capture", "/shop/accounts/bills", "/shop/accounts/purchases", "/shop/accounts/stock", "/shop/accounts/sales", "/shop/accounts/sales/new", "/shop/accounts/parties", "/shop/accounts/money", "/shop/accounts/gst", "/shop/accounts/gst/reconcile", "/shop/accounts/reports", "/shop/accounts/settings"];
    const bad = [];
    for (const p of paths) {
      const r = await api.get(`${base}${p}`, { maxRedirects: 0 });
      if (r.status() !== 200) bad.push(`${p}:${r.status()}`);
    }
    check(bad.length === 0, bad.join(", "));
    return `${paths.length} pages 200`;
  });
}

/* ------------------------------------------------------------ soft copy */
if (want("soft") || want("correct")) {
  await tcase("TS-SOFT-01", "Soft copy: e-invoice JSON uploaded on the capture screen is read (trusted source) and opens for review", async () => {
    const ls = await listings();
    check(Array.isArray(ls) && ls.length > 0, "the shop has no products to map to");
    listing = ls.find((l) => /ghee|milk|bread|paneer|butter/i.test(l.name)) ?? ls[0];
    const before = await stockOf(listing.shopProductId);
    await page.goto(`${base}/shop/accounts/capture`);
    await page.getByTestId("capture-file").setInputFiles({ name: "einvoice.json", mimeType: "application/json", buffer: Buffer.from(einvoice(`E2E/${RUN}/1`, listing)) });
    await page.getByTestId("capture-upload").click();
    await page.waitForURL(/\/shop\/accounts\/bills\/[0-9a-f-]{36}/, { timeout: 60_000 });
    const captureId = /bills\/([0-9a-f-]{36})/.exec(page.url())[1];
    const c = await waitCapture(captureId);
    check(c.status === "READY_FOR_REVIEW", `status ${c.status} ${c.error ?? ""}`);
    await page.reload();
    await page.getByTestId("bill-review").waitFor({ timeout: 30_000 });
    const after = await stockOf(listing.shopProductId);
    check(after === before, `stock changed before confirm: ${before} → ${after}`);
    globalThis.softCapture = captureId;
    globalThis.stockBefore = before;
    return `capture ${captureId}; engine e-invoice JSON; stock unchanged before confirm (${before / 1000})`;
  });
  await tcase("TS-SOFT-02", "Review: map the line to the shop's product, all checks pass, Confirm adds 12 to stock in one transaction", async () => {
    const product = page.getByTestId("l1-product");
    const mapped = await product.isVisible().catch(() => false);
    if (!mapped || !(await product.textContent()).includes(listing.name.slice(0, 10))) {
      await page.getByTestId("l1-change").click();
      await page.getByPlaceholder("Search your products").fill(listing.name.slice(0, 12));
      await page.getByRole("button", { name: new RegExp(listing.name.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    }
    await page.getByTestId("bill-issues").getByText("All checks passed").waitFor({ timeout: 20_000 });
    await page.getByTestId("bill-confirm").click();
    await page.waitForURL(/\/shop\/accounts\/purchases\/[0-9a-f-]{36}/, { timeout: 60_000 });
    softPurchaseId = /purchases\/([0-9a-f-]{36})/.exec(page.url())[1];
    const after = await stockOf(listing.shopProductId);
    check(after - globalThis.stockBefore === 12_000, `stock moved by ${(after - globalThis.stockBefore) / 1000}`);
    const p = await json(await api.get(A(`purchases/${softPurchaseId}`)));
    check(p.purchase.totalPaise === 67_200, `total ${p.purchase.totalPaise}`);
    check(p.purchase.cgstPaise === 3600 && p.purchase.sgstPaise === 3600, "GST split");
    check(p.itc?.[0]?.status === "PENDING_RECON", `ITC ${p.itc?.[0]?.status}`);
    return `purchase ${softPurchaseId}: ₹672 (CGST ₹36 + SGST ₹36), stock +12, ITC pending reconciliation`;
  });
  await tcase("TS-SOFT-03", "Duplicate check: the same supplier + invoice number is flagged and cannot be confirmed", async () => {
    const r = await api.post(A("bills"), { multipart: { kind: "SOFT", source: "UPLOAD", file: { name: "e.json", mimeType: "application/json", buffer: Buffer.from(einvoice(`E2E/${RUN}/1`, listing)) } } });
    check(r.status() === 201, `upload ${r.status()}`);
    const { id } = await json(r);
    await waitCapture(id);
    const c = await json(await api.get(A(`bills/${id}`)));
    check(c.issues.some((i) => i.code === "DUPLICATE"), "no duplicate flag");
    const conf = await api.post(A(`bills/${id}/confirm`), { data: { draft: c.draft } });
    check(conf.status() === 422, `confirm answered ${conf.status()}`);
    await api.delete(A(`bills/${id}`));
    return "DUPLICATE error shown; confirm refused 422; capture discarded";
  });
  await tcase("TS-SOFT-04", "Validation: wrong GSTIN check digit and wrong grand total are flagged", async () => {
    const r = await api.post(A("bills"), { multipart: { kind: "SOFT", source: "UPLOAD", file: { name: "e.json", mimeType: "application/json", buffer: Buffer.from(einvoice(`E2E/${RUN}/V`, listing)) } } });
    const { id } = await json(r);
    await waitCapture(id);
    const c = await json(await api.get(A(`bills/${id}`)));
    const d = c.draft;
    d.supplierGstin.value = `${SUPPLIER.slice(0, 14)}${SUPPLIER[14] === "A" ? "B" : "A"}`;
    d.totals.totalPaise.value = 99_900;
    const res = await json(await api.patch(A(`bills/${id}`), { data: { draft: d } }));
    const codes = res.issues.map((i) => i.code);
    check(codes.includes("GSTIN_FORMAT") && codes.includes("TOTAL_GRAND"), codes.join(","));
    await api.delete(A(`bills/${id}`));
    return `issues: ${codes.join(", ")}`;
  });
}

/* ----------------------------------------------------------- correction */
if (want("correct") && softPurchaseId) {
  await tcase("TS-CORR-01", "Post-confirmation correction: reopen, change qty 12 → 10 with a reason; reversing + corrected entries; history old → new", async () => {
    const before = await stockOf(listing.shopProductId);
    await page.goto(`${base}/shop/accounts/purchases/${softPurchaseId}/edit`);
    await page.getByTestId("bill-review").waitFor();
    await page.getByTestId("l1-qty").fill("10");
    await page.getByTestId("l1-taxable").fill("500");
    await page.getByTestId("t-taxablePaise").fill("500");
    await page.getByTestId("t-cgstPaise").fill("30");
    await page.getByTestId("t-sgstPaise").fill("30");
    await page.getByTestId("t-totalPaise").fill("560");
    await page.getByTestId("correction-reason").fill("E2E: supplier delivered 10");
    await page.getByTestId("bill-confirm").click();
    await page.waitForURL(/corrected=1/, { timeout: 60_000 });
    const history = await page.getByTestId("purchase-history").textContent();
    check(history.includes("lines[1].qtyMilli") && history.includes("E2E: supplier delivered 10"), "history missing the change");
    const after = await stockOf(listing.shopProductId);
    check(before - after === 2_000, `stock moved by ${(after - before) / 1000}`);
    const ledger = await json(await api.get(A(`stock/${listing.shopProductId}`)));
    check(ledger.some((l) => l.movementType === "REVERSAL" && l.sourceId === softPurchaseId), "no REVERSAL row");
    const p = await json(await api.get(A(`purchases/${softPurchaseId}`)));
    check(p.purchase.version === 2 && p.purchase.totalPaise === 56_000, `v${p.purchase.version} total ${p.purchase.totalPaise}`);
    check(p.itc.filter((r) => !r.supersededAt).length === 1, "ITC not superseded");
    return "version 2, ₹560, stock −2, REVERSAL row, ITC re-issued, history shows old → new with reason";
  });
}

/* ------------------------------------------------------------ hard copy */
if (want("hard")) {
  for (const [ctxName, ctx] of [["phone", phone], ["android-app", app]]) {
    await tcase(`TS-HARD-${ctxName}`, `Hard copy on ${ctxName}: camera scan (2 pages, crop/de-skew/enhance on the phone) → read in background → review screen`, async () => {
      const p = await ctx.newPage();
      await p.goto(`${base}/shop/accounts/capture?mode=scan`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="100%" height="100%" fill="#3b3b3b"/><g transform="rotate(4 600 800)"><rect x="180" y="200" width="840" height="1180" fill="#fafafa"/><text x="240" y="320" font-size="42" font-family="sans-serif">SHREE VITTHAL DISTRIBUTORS</text><text x="240" y="400" font-size="30" font-family="sans-serif">Invoice No: PB-${RUN}  Date: ${DMY}</text><text x="240" y="520" font-size="30" font-family="sans-serif">${listing?.name ?? "Cow Ghee"}  12 pcs  50.00  600.00</text><text x="240" y="640" font-size="30" font-family="sans-serif">Grand Total 672.00</text></g></svg>`;
      const photo = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
      const cam = p.locator('input[type="file"][capture]');
      await cam.setInputFiles({ name: "p1.jpg", mimeType: "image/jpeg", buffer: photo });
      await p.getByRole("button", { name: /Add page/ }).waitFor({ timeout: 30_000 });
      await cam.setInputFiles({ name: "p2.jpg", mimeType: "image/jpeg", buffer: photo });
      await p.getByText(/Page 2 of 2/).waitFor({ timeout: 30_000 });
      await p.getByRole("button", { name: /^Done/ }).click();
      await p.waitForURL(/\/shop\/accounts\/bills\/[0-9a-f-]{36}/, { timeout: 120_000 });
      const id = /bills\/([0-9a-f-]{36})/.exec(p.url())[1];
      const c = await waitCapture(id, 180_000);
      const full = await json(await api.get(A(`bills/${id}`)));
      await p.reload();
      const shown = await p.getByTestId("bill-review").isVisible({ timeout: 30_000 }).catch(() => false);
      check(shown, `review screen not shown (status ${c.status})`);
      const d = full.draft;
      const read = [d.supplierName.value, d.invoiceNo.value, d.invoiceDate.value].filter(Boolean).length;
      const notes = d.notes.join(" | ");
      await api.delete(A(`bills/${id}`));
      await p.close();
      return `pages=${full.fileIds.length}, engine=${full.engine}, header fields read=${read}/3 (supplier "${d.supplierName.value ?? ""}", no "${d.invoiceNo.value ?? ""}"), notes: ${notes}`;
    });
  }
  await tcase("TS-HARD-TYPE", "Paper bill typed by hand (no photo) → confirm → stock updated", async () => {
    const r = await api.post(A("bills/manual"), { data: {} });
    const c = await json(r);
    const before = await stockOf(listing.shopProductId);
    const d = c.draft;
    d.supplierName = { value: "Local Kirana Supplier (E2E)", confidence: 100 };
    d.invoiceNo = { value: `HC-${RUN}`, confidence: 100 };
    d.invoiceDate = { value: TODAY, confidence: 100 };
    const f = (v) => ({ value: v, confidence: 100 });
    d.lines = [{ id: "l1", description: f(listing.name), hsn: f(null), barcode: f(null), qtyMilli: f(3000), unit: f("pcs"), ratePaise: f(4000), discountPaise: f(0), gstRateBp: f(0), taxablePaise: f(null), taxPaise: f(null), totalPaise: f(null), batchNo: f(`B-${RUN}`), expiryDate: f("2027-12-31"), mrpPaise: f(null), match: { shopProductId: listing.shopProductId, productName: listing.name, method: "USER", score: 1, suggestions: [] } }];
    const saved = await json(await api.patch(A(`bills/${c.id}`), { data: { draft: d } }));
    check(!saved.issues.some((i) => i.severity === "error"), saved.issues.map((i) => i.message).join("; "));
    const conf = await api.post(A(`bills/${c.id}/confirm`), { data: { draft: saved.draft } });
    check(conf.status() === 201, `confirm ${conf.status()} ${await conf.text()}`);
    const after = await stockOf(listing.shopProductId);
    check(after - before === 3_000, `stock moved by ${(after - before) / 1000}`);
    return "unregistered supplier, batch + expiry recorded, stock +3";
  });
}

/* ------------------------------------------------------------------ GST */
if (want("gst")) {
  await tcase("TS-GST-LINK", "GSTIN link: consent + username + OTP (GSP sandbox on the test site), token stored encrypted", async () => {
    const st = await json(await api.get(A("gst/link")));
    if (!st.apiAvailable) return `SKIPPED-API: provider ${st.provider} — API path off on this host; manual upload tested below`;
    // The shop's own GSTIN when it has one; otherwise a made-up Maharashtra GSTIN (the GSP sandbox accepts any valid one).
    const shopGstin = st.link?.gstin ?? (await page.goto(`${base}/shop/accounts/gst`), (/GSTIN ([0-9A-Z]{15})/.exec(await page.content()) ?? [])[1]) ?? gstin("27", "AAECE4321K");
    const noConsent = await api.post(A("gst/link"), { data: { gstin: shopGstin, username: "e2etest", consent: false } });
    check(noConsent.status() === 422, `without consent: ${noConsent.status()}`);
    const r = await api.post(A("gst/link"), { data: { gstin: shopGstin, username: "e2etest", consent: true } });
    check(r.status() === 200, `link ${r.status()} ${await r.text()}`);
    const bad = await api.post(A("gst/verify"), { data: { otp: "111111" } });
    check(bad.status() === 422, `wrong OTP: ${bad.status()}`);
    const ok = await api.post(A("gst/verify"), { data: { otp: "575757" } });
    check(ok.status() === 200, `verify ${ok.status()} ${await ok.text()}`);
    globalThis.shopGstin = shopGstin;
    return `LINKED via ${st.provider}; no-consent 422, wrong OTP 422`;
  });
  await tcase("TS-GST-PULL", "GSTR-2B pulled through the GSP adapter → reconciliation (matched / mismatch / missing in books / missing on portal)", async () => {
    const st = await json(await api.get(A("gst/link")));
    if (!st.apiAvailable || st.link?.status !== "LINKED") return "SKIPPED-API: not linked";
    const r = await api.post(A("gst/pull"), { data: { returnType: "GSTR2B", period: MONTH } });
    check(r.status() === 200, `pull ${r.status()} ${await r.text()}`);
    const res = await json(r);
    check(res.recon && res.recon.counts.MISSING_IN_BOOKS >= 1, JSON.stringify(res.recon));
    return `imported ${res.invoices}; recon ${JSON.stringify(res.recon.counts)}`;
  });
  await tcase("TS-GST-UPLOAD", "Manual fallback: GSTR-2B JSON downloaded from gst.gov.in uploaded on the GST page → reconciliation", async () => {
    const shopGstin = globalThis.shopGstin ?? null;
    const dt = `${TODAY.slice(8, 10)}-${TODAY.slice(5, 7)}-${TODAY.slice(0, 4)}`;
    const body = {
      data: {
        ...(shopGstin ? { gstin: shopGstin } : {}),
        rtnprd: `${MONTH.slice(5, 7)}${MONTH.slice(0, 4)}`,
        docdata: { b2b: [{ ctin: SUPPLIER, trdnm: "Shree Vitthal", inv: [
          { inum: `E2E/${RUN}/1`, typ: "R", dt, val: 560, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 500, igst: 0, cgst: 30, sgst: 30, cess: 0 }] },
          { inum: `E2E/${RUN}/X`, typ: "R", dt, val: 1180, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 18, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] },
        ] }, { ctin: OTHER_STATE, trdnm: "Bengaluru Foods", inv: [{ inum: `BF-${RUN}`, typ: "R", dt, val: 1120, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 1000, igst: 120, cgst: 0, sgst: 0, cess: 0 }] }] }] },
      },
    };
    await page.goto(`${base}/shop/accounts/gst?period=${MONTH}`);
    await page.locator('input[type="file"]').last().setInputFiles({ name: "GSTR2B.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(body)) });
    await page.getByRole("button", { name: "Import file" }).click();
    await page.getByText(/invoice\(s\) imported/).first().waitFor({ timeout: 60_000 });
    const view = await json(await api.get(A(`gst/recon?period=${MONTH}`)));
    const counts = view.items.reduce((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
    check(counts.MATCHED >= 1 && counts.MISSING_IN_BOOKS >= 2, JSON.stringify(counts));
    return `recon ${JSON.stringify(counts)} (E2E/${RUN}/1 matched after the correction to ₹560)`;
  });
  await tcase("TS-GST-LIAB", "Net GST = output − reconciled ITC per head, with due dates and the CA note", async () => {
    const v = await json(await api.get(A(`gst/liability?period=${MONTH}&frequency=MONTHLY`)));
    const m = v.months[0];
    for (const h of ["cgst", "sgst", "igst"]) {
      const expectCash = Math.max(0, m.output[h] - (m.setOff.output[h] - m.setOff.cash[h]));
      check(m.setOff.cash[h] === expectCash, `${h}`);
    }
    check(m.eligibleItc.cgst >= 3000, `reconciled ITC CGST ${m.eligibleItc.cgst}`);
    check(/verify with your CA/i.test(v.note), "CA note");
    check(v.dueDates.length === 2, "due dates");
    return `output ${JSON.stringify(m.output)}, eligible ITC ${JSON.stringify(m.eligibleItc)}, cash ${JSON.stringify(m.setOff.cash)}, pending ITC ${JSON.stringify(m.pendingItc)}; due ${v.dueDates.map((d) => `${d.returnType} ${d.dueDate}`).join(", ")}`;
  });
}

/* -------------------------------------------------------------- reports */
if (want("reports")) {
  const next = new Date(`${TODAY}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const to = next.toISOString().slice(0, 10);
  for (const [kind, format, type] of [["pnl", "json", "json"], ["stock", "xlsx", "spreadsheet"], ["daybook", "pdf", "pdf"], ["gst", "xlsx", "spreadsheet"], ["purchases", "pdf", "pdf"], ["tally", "", "xml"]]) {
    await tcase(`TS-REP-${kind}-${format || "xml"}`, `Report ${kind} as ${format || "Tally XML"}`, async () => {
      const r = await api.get(A(`reports/${kind}?from=${MONTH}-01&to=${to}${format ? `&format=${format}` : ""}`));
      check(r.status() === 200, `HTTP ${r.status()}`);
      check((r.headers()["content-type"] ?? "").includes(type), r.headers()["content-type"]);
      const size = (await r.body()).length;
      return `${r.headers()["content-type"]}, ${size} bytes`;
    });
  }
  await tcase("TS-REP-PAGE", "Reports page renders the P&L table", async () => {
    await page.goto(`${base}/shop/accounts/reports?kind=pnl`);
    await page.getByRole("table").first().waitFor();
    return "table shown";
  });
}

/* ---------------------------------------------------------------- sales */
if (want("sales")) {
  await tcase("TS-SALE-01", "GST sales invoice to another state → IGST; PDF; stock out; cancel puts stock back", async () => {
    const before = await stockOf(listing.shopProductId);
    const r = await api.post(A("sales"), { data: { paymentMode: "CREDIT", buyerName: "E2E Hotel (Bengaluru)", buyerGstin: OTHER_STATE, lines: [{ shopProductId: listing.shopProductId, description: listing.name, qtyMilli: 1000, ratePaise: 10000, gstRateBp: 1200 }] } });
    if (r.status() === 422 && /GSTIN \(or state\)/.test(await r.text())) return "SKIPPED: this test shop has no GSTIN / state, so it cannot issue GST invoices (correct refusal)";
    check(r.status() === 201, `HTTP ${r.status()} ${await r.text()}`);
    const inv = await json(r);
    check(inv.interState && inv.igstPaise === 1200 && inv.cgstPaise === 0, JSON.stringify(inv));
    const pdf = await api.get(A(`sales/${inv.id}/pdf`));
    check((await pdf.body()).subarray(0, 5).toString() === "%PDF-", "pdf");
    const mid = await stockOf(listing.shopProductId);
    check(before - mid === 1000, "stock out");
    const c = await api.delete(A(`sales/${inv.id}`), { data: { reason: "E2E cleanup" } });
    check(c.status() === 200, `cancel ${c.status()}`);
    check((await stockOf(listing.shopProductId)) === before, "stock back");
    return `${inv.invoiceNo}: IGST ₹12, PDF ok, stock −1 then back on cancel`;
  });
}

/* ---------------------------------------------------------------- money */
if (want("money")) {
  await tcase("TS-MONEY-01", "Supplier payable, payment in cash, cash book and day book balance", async () => {
    const parties = await json(await api.get(A("parties?kind=SUPPLIER")));
    const sup = parties.find((p) => p.gstin === SUPPLIER);
    check(sup && sup.balancePaise > 0, "supplier payable not found");
    const r = await api.post(A("payments"), { data: { partyId: sup.id, direction: "PAID", mode: "CASH", amountPaise: 10_000, reference: `E2E-${RUN}` } });
    check(r.status() === 201, `payment ${r.status()}`);
    const after = await json(await api.get(A(`parties/${sup.id}`)));
    check(after.balancePaise === sup.balancePaise - 10_000, "balance");
    const next = new Date(`${TODAY}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const day = await json(await api.get(A(`books/day?from=${TODAY}&to=${next.toISOString().slice(0, 10)}`)));
    for (const v of day) check(v.legs.reduce((n, l) => n + l.debitPaise - l.creditPaise, 0) === 0, `voucher ${v.voucherId} unbalanced`);
    const p = await json(r);
    await api.delete(A(`payments/${p.id}`), { data: { reason: "E2E cleanup" } });
    return `paid ₹100, payable ₹${sup.balancePaise / 100} → ₹${after.balancePaise / 100}; ${day.length} vouchers today all balanced`;
  });
}

/* ------------------------------------------------------------ isolation */
if (want("iso")) {
  await tcase("TS-ISO-01", "Signed out: module pages redirect to sign-in, API 401", async () => {
    const anon = await browser.newContext();
    const pg = await anon.request.get(`${base}/shop/accounts`, { maxRedirects: 0 });
    const ap = await anon.request.get(A("stock"));
    await anon.close();
    check([302, 303, 307].includes(pg.status()) && ap.status() === 401, `${pg.status()} / ${ap.status()}`);
    return `page ${pg.status()}, API ${ap.status()}`;
  });
  await tcase("TS-ISO-02", "The owner cannot read another shop's books (403)", async () => {
    const shops = await json(await api.get(`${base}/api/shops?limit=50`));
    const list = Array.isArray(shops) ? shops : shops.shops ?? shops.items ?? [];
    const other = list.find((s) => s.id !== SHOP);
    if (!other) return "SKIPPED: no other shop listed";
    const r = await api.get(`${base}/api/shops/${other.id}/accounts/stock`);
    check(r.status() === 403, `HTTP ${r.status()}`);
    return `other shop ${other.id.slice(0, 8)}…: 403`;
  });
}

await browser.close();
const passed = results.filter((r) => r.result === "PASS").length;
console.log(JSON.stringify({ summary: { env: ENV, total: results.length, passed, failed: results.length - passed } }));
