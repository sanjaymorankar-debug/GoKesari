/**
 * Inventory & Accounting end to end (docs/inventory-accounting-2026-10), in a
 * real browser against a running server and its database — desktop, phone
 * (Pixel 7) and the Android app's WebView (its user agent):
 *
 *   tile board → upload an e-invoice (soft copy) → review → confirm → stock up
 *   → scan a paper bill (hard copy, camera input) → review screen
 *   → reopen the purchase, correct it → history shows old → new
 *   → GST: upload GSTR-2B JSON (manual fallback) → reconciliation → liability
 *   → reports + Excel / Tally export.
 *
 *   E2E_DATABASE_URL=… AUTH_SECRET=… E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/inventory-accounting.spec.ts
 *
 * Signing in mints the Auth.js session cookie with the server's AUTH_SECRET,
 * as regression-items-a-e.spec.ts does (production builds have no test login).
 * The database is only used to arrange data (a shop with a GSTIN and two
 * products) and to read results a person would read off a screen.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { encode } from "next-auth/jwt";
import postgres from "postgres";
import sharp from "sharp";

const DB_URL = process.env.E2E_DATABASE_URL;
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const SESSION_COOKIE = BASE_URL.startsWith("https") ? "__Secure-authjs.session-token" : "authjs.session-token";
const APP_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36 GoKesariApp/1.0.0 (android)";

test.skip(!DB_URL || !AUTH_SECRET, "E2E_DATABASE_URL and AUTH_SECRET (the server's) are required");
const sql = postgres(DB_URL ?? "postgres://invalid", { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

function gstin(state: string, body: string): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const g = `${state}${body}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return g + chars[(36 - (sum % 36)) % 36];
}

const RUN = Date.now().toString(36).toUpperCase();
const SHOP_GSTIN = gstin("27", `AA${RUN.slice(-3).padStart(3, "A").replace(/[0-9]/g, "K")}K1234A`.slice(0, 10));
const SUPPLIER = gstin("27", "AABCS5678B");
const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const DMY = `${TODAY.slice(8, 10)}/${TODAY.slice(5, 7)}/${TODAY.slice(0, 4)}`;

interface Setup {
  shopId: string;
  email: string;
  gheeId: string;
}

/** A fresh shop owner with a GSTIN-registered shop and two products. */
async function arrange(tag: string): Promise<Setup> {
  const email = `e2e-acc-${tag}-${RUN.toLowerCase()}@test.local`;
  const [user] = await sql`insert into users (email, role, name, phone, phone_e164, phone_verified_at, profile_completed_at)
                           values (${email}, 'SHOP_OWNER', ${"E2E Accounts " + tag}, ${"8" + randomDigits(9)}, null, now(), now()) returning id`;
  await sql`update users set phone_e164 = '+91' || phone where id = ${user.id}`;
  await sql`insert into wallets (user_id) values (${user.id}) on conflict do nothing`;
  const [category] = await sql`select id from product_categories where deleted_at is null order by created_at limit 1`;
  const [shop] = await sql`insert into shops (owner_id, name, slug, owner_name, phone, address_line1, city, state, pincode, shop_type, status, gstin)
                           values (${user.id}, ${"E2E Accounts " + tag}, ${"e2e-acc-" + tag + "-" + RUN.toLowerCase()}, 'Owner', '9999999999', '1 Test Road', 'Pune', 'Maharashtra', '411001', 'DAIRY', 'APPROVED', ${SHOP_GSTIN})
                           returning id`;
  await sql`insert into shop_product_categories (shop_id, category_id) values (${shop.id}, ${category.id}) on conflict do nothing`;
  const [ghee] = await sql`insert into products (category_id, name, slug, unit, unit_size_milli, gtin, hsn_code, gst_rate_bp)
                           values (${category.id}, ${"E2E Cow Ghee 1 L " + RUN}, ${"e2e-ghee-" + tag + "-" + RUN.toLowerCase()}, 'piece', 1000, ${"89" + randomDigits(11)}, '0405', 1200) returning id, gtin`;
  const [sp] = await sql`insert into shop_products (shop_id, product_id, online_price_paise, online_sale_enabled, online_stock)
                         values (${shop.id}, ${ghee.id}, 65000, true, 2) returning id`;
  await sql`update products set barcode = ${ghee.gtin} where id = ${ghee.id}`;
  return { shopId: shop.id, email, gheeId: sp.id };
}

function randomDigits(n: number): string {
  let s = "";
  while (s.length < n) s += String(Math.floor(Math.random() * 10));
  return s;
}

async function signedInPage(browser: Browser, email: string, options: { mobile?: boolean; app?: boolean } = {}): Promise<Page> {
  const [user] = await sql`select id, name from users where email = ${email}`;
  const value = await encode({ token: { sub: user.id, email, name: user.name }, secret: AUTH_SECRET, salt: SESSION_COOKIE });
  const context = await browser.newContext(
    options.app || options.mobile ? { viewport: { width: 412, height: 915 }, userAgent: options.app ? APP_UA : undefined, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } },
  );
  await context.addCookies([{ name: SESSION_COOKIE, value, url: BASE_URL }]);
  return context.newPage();
}

function einvoice(invoiceNo: string, barcode: string) {
  return JSON.stringify({
    Version: "1.1",
    DocDtls: { Typ: "INV", No: invoiceNo, Dt: DMY },
    SellerDtls: { Gstin: SUPPLIER, LglNm: "Shree Vitthal Distributors", Stcd: "27" },
    BuyerDtls: { Gstin: SHOP_GSTIN, LglNm: "E2E", Pos: "27", Stcd: "27" },
    ItemList: [{ SlNo: "1", PrdDesc: "COW GHEE 1LTR JAR", HsnCd: "04051000", Barcde: barcode, Qty: 12, Unit: "NOS", UnitPrice: 550, TotAmt: 6600, Discount: 0, AssAmt: 6600, GstRt: 12, IgstAmt: 0, CgstAmt: 396, SgstAmt: 396, CesAmt: 0, TotItemVal: 7392 }],
    ValDtls: { AssVal: 6600, CgstVal: 396, SgstVal: 396, IgstVal: 0, CesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: 7392 },
  });
}

const stock = async (spId: string) => Number((await sql`select online_stock from shop_products where id = ${spId}`)[0].online_stock);

test.describe.configure({ mode: "serial" });

test("tile board fits one screen and every tile opens its page", async ({ browser }, info) => {
  const s = await arrange(`board${info.project.name}`);
  const page = await signedInPage(browser, s.email, { mobile: info.project.name === "mobile" });
  await page.goto("/shop/accounts");
  const tiles = page.getByTestId("accounts-tile");
  await expect(tiles).toHaveCount(12);
  await expect(page.getByTestId("accounts-facts")).toBeVisible();
  // One screen: the last tile is visible without scrolling.
  await expect(tiles.last()).toBeInViewport();
  for (const key of ["purchases", "stock", "gst", "reports", "parties", "money", "sales", "settings"]) {
    const res = await page.request.get(await page.locator(`[data-key="${key}"]`).getAttribute("href") ?? "/");
    expect(res.status(), key).toBe(200);
  }
});

test("soft copy: e-invoice upload → review → confirm adds stock; correction re-syncs with history", async ({ browser }, info) => {
  const s = await arrange(`soft${info.project.name}`);
  const [{ barcode }] = await sql`select p.barcode from shop_products sp join products p on p.id = sp.product_id where sp.id = ${s.gheeId}`;
  const page = await signedInPage(browser, s.email, { mobile: info.project.name === "mobile" });
  await page.goto("/shop/accounts/capture");
  await page.getByTestId("capture-file").setInputFiles({ name: "einvoice.json", mimeType: "application/json", buffer: Buffer.from(einvoice(`E2E/${RUN}/1`, barcode)) });
  await page.getByTestId("capture-upload").click();
  await page.waitForURL(/\/shop\/accounts\/bills\/[0-9a-f-]{36}/);
  await expect(page.getByTestId("bill-review")).toBeVisible({ timeout: 60_000 });
  // Nothing in stock before confirming.
  expect(await stock(s.gheeId)).toBe(2);
  if (info.project.name === "mobile") await page.getByRole("tab", { name: /Details to check/ }).click();
  await expect(page.getByTestId("l1-product")).toContainText("E2E Cow Ghee");
  await expect(page.getByTestId("bill-issues")).toContainText("All checks passed");
  await page.getByTestId("bill-confirm").click();
  await page.waitForURL(/\/shop\/accounts\/purchases\/[0-9a-f-]{36}/);
  await expect(page.getByText("Confirmed: stock added")).toBeVisible();
  expect(await stock(s.gheeId)).toBe(14);

  // Reopen and correct: 12 → 10.
  await page.getByRole("link", { name: "Reopen & correct" }).click();
  await expect(page.getByTestId("bill-review")).toBeVisible();
  if (info.project.name === "mobile") await page.getByRole("tab", { name: /Details to check/ }).click();
  await page.getByTestId("l1-qty").fill("10");
  await page.getByTestId("l1-taxable").fill("5500");
  await page.getByTestId("t-cgstPaise").fill("330");
  await page.getByTestId("t-sgstPaise").fill("330");
  await page.getByTestId("t-taxablePaise").fill("5500");
  await page.getByTestId("t-totalPaise").fill("6160");
  await page.getByTestId("correction-reason").fill("supplier sent 10, not 12");
  await page.getByTestId("bill-confirm").click();
  await page.waitForURL(/corrected=1/);
  await expect(page.getByTestId("purchase-history")).toContainText("lines[1].qtyMilli");
  await expect(page.getByTestId("purchase-history")).toContainText("supplier sent 10, not 12");
  expect(await stock(s.gheeId)).toBe(12);
  const [{ n }] = await sql`select count(*)::int n from inv_stock_ledger where shop_product_id = ${s.gheeId} and movement_type = 'REVERSAL'`;
  expect(n).toBe(1);
});

test("hard copy: scan a paper bill with the camera input, several pages, then review", async ({ browser }, info) => {
  const s = await arrange(`hard${info.project.name}`);
  const page = await signedInPage(browser, s.email, { mobile: info.project.name === "mobile", app: info.project.name === "mobile" });
  await page.goto("/shop/accounts/capture?mode=scan");
  // A white bill on a dark table, rotated a little.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="100%" height="100%" fill="#3b3b3b"/><g transform="rotate(4 600 800)"><rect x="180" y="200" width="840" height="1180" fill="#fafafa"/><text x="240" y="320" font-size="42" font-family="sans-serif">SHREE VITTHAL DISTRIBUTORS</text><text x="240" y="400" font-size="30" font-family="sans-serif">Invoice No: PB-${RUN}  Date: ${DMY}</text><text x="240" y="520" font-size="30" font-family="sans-serif">Cow Ghee 1L  12 pcs  550.00  6600.00</text><text x="240" y="640" font-size="30" font-family="sans-serif">Grand Total 7392.00</text></g></svg>`;
  const photo = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  const cameraInput = page.locator('input[type="file"][capture]');
  await cameraInput.setInputFiles({ name: "page1.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByRole("button", { name: /Add page/ })).toBeVisible({ timeout: 30_000 });
  await cameraInput.setInputFiles({ name: "page2.jpg", mimeType: "image/jpeg", buffer: photo });
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /^Done/ }).click();
  await page.waitForURL(/\/shop\/accounts\/bills\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByTestId("bill-review").or(page.getByTestId("bill-progress"))).toBeVisible();
  await expect(page.getByTestId("bill-review")).toBeVisible({ timeout: 90_000 });
  const [capture] = await sql`select kind, source, cardinality(file_ids) pages from inv_bill_captures where shop_id = ${s.shopId} order by created_at desc limit 1`;
  expect(capture).toMatchObject({ kind: "HARD", source: "CAMERA", pages: 2 });
});

test("GST: GSTR-2B JSON upload (manual fallback) → reconciliation → liability", async ({ browser }, info) => {
  test.skip(info.project.name === "mobile", "data flow covered on desktop; the GST pages are opened on the phone in the board test");
  const s = await arrange("gst");
  const [{ barcode }] = await sql`select p.barcode from shop_products sp join products p on p.id = sp.product_id where sp.id = ${s.gheeId}`;
  const page = await signedInPage(browser, s.email);
  // Two bills through the API (the UI path is covered above).
  for (const no of [`G-${RUN}-1`, `G-${RUN}-2`]) {
    const up = await page.request.post(`/api/shops/${s.shopId}/accounts/bills`, { multipart: { kind: "SOFT", source: "UPLOAD", file: { name: "e.json", mimeType: "application/json", buffer: Buffer.from(einvoice(no, barcode)) } } });
    expect(up.status()).toBe(201);
    const { id } = await up.json();
    let draft = null;
    for (let i = 0; i < 40 && !draft; i += 1) {
      const c = await (await page.request.get(`/api/shops/${s.shopId}/accounts/bills/${id}`)).json();
      if (c.status === "READY_FOR_REVIEW") draft = c.draft;
      else await page.waitForTimeout(1000);
    }
    const ok = await page.request.post(`/api/shops/${s.shopId}/accounts/bills/${id}/confirm`, { data: { draft } });
    expect(ok.status()).toBe(201);
  }
  const dt = `${TODAY.slice(8, 10)}-${TODAY.slice(5, 7)}-${TODAY.slice(0, 4)}`;
  const gstr2b = { data: { gstin: SHOP_GSTIN, rtnprd: `${MONTH.slice(5, 7)}${MONTH.slice(0, 4)}`, docdata: { b2b: [{ ctin: SUPPLIER, trdnm: "Shree Vitthal", inv: [{ inum: `G-${RUN}-1`, typ: "R", dt, val: 7392, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 12, txval: 6600, igst: 0, cgst: 396, sgst: 396, cess: 0 }] }, { inum: `X-${RUN}`, typ: "R", dt, val: 1180, pos: "27", rev: "N", itcavl: "Y", items: [{ num: 1, rt: 18, txval: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }] }] }] } } };
  await page.goto(`/shop/accounts/gst?period=${MONTH}`);
  const fileInput = page.locator('input[type="file"]').last();
  await fileInput.setInputFiles({ name: "gstr2b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(gstr2b)) });
  await page.getByRole("button", { name: /^Upload/ }).last().click();
  await expect(page.getByText(/imported/i).first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/shop/accounts/gst/reconcile?period=${MONTH}`);
  for (const t of ["Matched", "Missing in books", "Missing on portal"]) await expect(page.getByText(t).first()).toBeVisible();
  const items = await sql`select status from gst_recon_items where shop_id = ${s.shopId} and period = ${MONTH} order by status`;
  expect(items.map((r) => r.status).sort()).toEqual(["MATCHED", "MISSING_IN_BOOKS", "MISSING_ON_PORTAL"]);
  await page.goto(`/shop/accounts/gst?period=${MONTH}`);
  await expect(page.getByText(/verify with your CA/i).first()).toBeVisible();
});

test("reports render and export to Excel, PDF and Tally XML", async ({ browser }, info) => {
  const s = await arrange(`rep${info.project.name}`);
  const page = await signedInPage(browser, s.email, { mobile: info.project.name === "mobile" });
  await page.goto("/shop/accounts/reports?kind=stock");
  await expect(page.getByRole("table").first()).toBeVisible();
  const from = `${MONTH}-01`;
  const next = new Date(`${TODAY}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const to = next.toISOString().slice(0, 10);
  for (const [kind, format, type] of [["pnl", "xlsx", "spreadsheet"], ["gst", "pdf", "pdf"], ["tally", "", "xml"]] as const) {
    const res = await page.request.get(`/api/shops/${s.shopId}/accounts/reports/${kind}?from=${from}&to=${to}${format ? `&format=${format}` : ""}`);
    expect(res.status(), kind).toBe(200);
    expect(res.headers()["content-type"]).toContain(type);
  }
});

test("another shop owner cannot open this shop's books", async ({ browser }) => {
  const a = await arrange("iso-a");
  const b = await arrange("iso-b");
  const page = await signedInPage(browser, b.email);
  const res = await page.request.get(`/api/shops/${a.shopId}/accounts/stock`);
  expect(res.status()).toBe(403);
  const anon = await (await browser.newContext()).request.get(`${BASE_URL}/api/shops/${a.shopId}/accounts/stock`);
  expect(anon.status()).toBe(401);
});
