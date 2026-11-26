/**
 * Group C (20-Nov-2026), the parts that need the local server: a new shop going through the
 * guided set-up from nothing, product imports that are really committed, setup-file errors
 * that need a product outside the shop's categories and an 11 MB file, the starter shelf and
 * barcode scan on step 7 of the registration, and "How you deliver" saved with its effect on
 * customers (radius, pickup only).
 *
 * Local tier: every shop here is a fresh owner's shop (lib/sellers-helpers), master products
 * and categories are arranged in the database, and a registration draft is arranged so the
 * registration's live step and starter shelf open for a shop made through the API. The
 * camera is not used: barcodes are typed into the scanner's "Barcode number" field, which
 * goes through the same look-up.
 */
import type { APIRequestContext, Page } from "@playwright/test";

import { as, pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { call, expectStatus, RUN, why } from "../lib/http";
import {
  arrangeWizardDraft,
  COL,
  downloadFrom,
  importPreview,
  importRows,
  importWorkbook,
  newCategory,
  openStarterShelf,
  productWithBarcode,
  PU_COLUMNS,
  settledUpload,
  SETUP_HEADERS,
  setupListings,
  sheetRows,
  shelfSignals,
  statusOf,
  stockRow,
  uploadSetupFile,
  waitImportJob,
  workbook,
  XLSX_TYPE,
} from "../lib/product-setup-helpers";
import { blocked, expect, need, qa } from "../lib/record";
import { approvedShopOfNewOwner, newMasterProduct, pageFor, sellingShop } from "../lib/sellers-helpers";
import { checkoutAs, clearCart, fillCart, pointNorth, validateCart, withAddresses } from "../lib/shopping-helpers";
import { world } from "../lib/world";

const local = { tier: "local" as const, timeout: 420_000 };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rupees = (paise: number) => (paise / 100).toFixed(paise % 100 === 0 ? 0 : 2);

/** A fresh owner's approved shop at shop A's spot (radius 5 km, delivering), no products. */
async function freshShop(label: string) {
  const made = await approvedShopOfNewOwner(label);
  const loc = need(world().location, "shop A's location in the world");
  await db()`
    update shops set latitude = ${String(loc.lat)}, longitude = ${String(loc.lng)}, location_verified = true,
      location_verified_at = now(), location_source = 'qa_seed', service_radius_km = 5, delivery_available = true
    where id = ${made.shop.id}`;
  return made;
}

/** A fresh shop whose registration is at its live step, with one product category of `products` packaged items (MRP ₹30, ₹40…). */
async function shelfShop(label: string, products = 3) {
  const made = await freshShop(label);
  const category = await newCategory(`Shelf ${label}`);
  const items = [];
  for (let i = 0; i < products; i++) items.push(await newMasterProduct({ name: `QA Shelf ${label} ${RUN} ${i}`, mrpPaise: 3000 + i * 1000, categoryId: category.id }));
  expectStatus(await call(made.ctx, "POST", `/api/shops/${made.shop.id}/product-categories`, { categoryId: category.id }), [200, 201], "the shop takes the category");
  await arrangeWizardDraft(made.owner.id, made.shop.id);
  return { ...made, category, items };
}

async function shelfApi(ctx: APIRequestContext, shopId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/starter-shelf`);
  expectStatus(res, 200, "GET starter shelf");
  if (!res.body.enabled) blocked("rule starterShelf is off on this server");
  return res.body as { enabled: boolean; defaultStock: number; items: { productId: string; name: string; kind: string; mrpPaise: number | null }[] };
}

/** Opens the scanner on the starter shelf and types a code. */
async function typeBarcode(page: Page, code: string) {
  await page.getByRole("button", { name: "📷 Scan a barcode" }).click();
  await expect(page.getByTestId("barcode-scanner")).toBeVisible();
  await page.getByLabel("Barcode number").fill(code);
  await page.getByRole("button", { name: "Find", exact: true }).click();
}

/* ------------------------------------------------------ guided set-up */

qa("TC-CAT-071", "a new shop with no products: choose 2 categories (lists nothing), tick 5 products on screen, set stock and price → 5 Live; then 2 more through 'Add in bulk with Excel'", async ({ browser }) => {
  const made = await freshShop("setup");
  const qaCategory = need(world().category, "the world's QA category");
  const products = [];
  for (let i = 0; i < 7; i++) products.push(await newMasterProduct({ name: `QA Setup ${RUN} item ${i}`, mrpPaise: 4000 + i * 100, categoryId: qaCategory.id }));
  const { context, page } = await pageFor(browser, made.owner);
  try {
    await page.goto("/shop/product-categories");
    const empty = page.getByTestId("setup-empty");
    if (await empty.count()) {
      await expect(empty).toContainText("Start by choosing what your shop sells");
      await empty.getByRole("link", { name: "Choose categories" }).click();
    }
    const progress = page.getByTestId("setup-progress");
    await expect(progress).toContainText("Step 1 of 3: Choose categories");
    const tiles = page.getByTestId("category-tiles");
    await tiles.getByRole("button", { name: new RegExp(escape(qaCategory.name)) }).click();
    const other = tiles.getByRole("button", { pressed: false }).first();
    const otherName = (await other.innerText()).split("\n")[0];
    await other.click();
    await page.getByRole("button", { name: /^Continue with \d+ categories$/ }).click();
    await expect(progress).toContainText("Step 2 of 3: Add products");
    expect((await setupListings(made.ctx, made.shop.id)).length, "choosing categories lists nothing").toBe(0);
    await expect(page.getByTestId("add-choice").getByRole("link", { name: /Add in bulk with Excel/ })).toBeVisible();
    await page.getByTestId("add-choice").getByRole("link", { name: /Select products on screen/ }).click();
    await page.getByPlaceholder("Name, brand or product ID").fill(`QA Setup ${RUN}`);
    await page.getByPlaceholder("Name, brand or product ID").press("Enter");
    for (const p of products.slice(0, 5)) await page.getByLabel(`Select ${p.name}`, { exact: true }).check();
    await page.getByRole("button", { name: "Continue with 5 selected" }).click();
    await expect(progress).toContainText("Step 3 of 3: Set stock and price");
    await expect(page.getByTestId("stock-row")).toHaveCount(5);
    // Nothing is selected at first (owner brief 25-Nov-2026): pick the five, then the bulk tools show.
    await page.getByLabel(/^Select this page/).check();
    const stock = page.getByLabel("Same stock for selected");
    await stock.fill("10");
    await stock.locator("xpath=ancestor::div[1]").getByRole("button", { name: "Apply" }).click();
    await page.getByRole("button", { name: "Save and go live" }).click();
    // The summary ("5 live, 0 need stock or price") shows until the page refreshes, which then shows the empty step 3
    // ("No products are waiting for stock or price."); the five being Live is checked on the listings below.
    await expect(page.getByTestId("setup-result").or(page.getByText("No products are waiting for stock or price.", { exact: true })).first()).toBeVisible();
    if (await page.getByTestId("setup-result").isVisible()) await expect(page.getByTestId("setup-result")).toContainText("5 live, 0 need stock or price");

    await page.goto("/shop/product-categories?step=2&mode=excel");
    const template = await downloadFrom(page, page.getByRole("link", { name: "Download template" }));
    const rows = await sheetRows(template.bytes, "Products");
    expect(rows[0]).toEqual([...SETUP_HEADERS]);
    const rest = products.slice(5).map((p) => {
      const row = need(rows.find((r) => r[COL.id].toUpperCase() === p.code.toUpperCase()), `${p.name} in the template`);
      return row.map((v, i) => (i === COL.include ? "Yes" : i === COL.stock ? 6 : i === COL.price || i === COL.masterMrp ? (v === "" ? null : Number(v)) : v || null));
    });
    const name = `qa-setup-template-${RUN}.xlsx`;
    await page.getByLabel("Choose your file").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: await workbook(SETUP_HEADERS, rest, name) });
    await expect(page.getByTestId("upload-preview")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("upload-preview").getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByTestId("setup-result")).toContainText("2 live, 0 need stock or price", { timeout: 120_000 });
    const listings = await setupListings(made.ctx, made.shop.id);
    const ours = products.map((p) => need(listings.find((l) => l.productId === p.id), `${p.name} listed`));
    expect(ours.map((l) => statusOf(l)), "all seven Live").toEqual(Array(7).fill("LIVE"));
    expect(ours.map((l) => Number(l.onlineStock))).toEqual([10, 10, 10, 10, 10, 6, 6]);
    return `categories ${qaCategory.name} + ${otherName}: nothing listed; 5 picked on screen at stock 10 → "5 live"; 2 by Excel → "2 live"; all 7 Live at MRP`;
  } finally {
    await context.close();
  }
}, local);

/* ------------------------------------------------- product import commit */

qa(["TC-CAT-076", "TC-CAT-077", "TC-CAT-078", "TC-CAT-080", "TC-CAT-081"], "a product file with 5 packaged rows, 1 loose row without MRP and 4 bad rows: the 6 good rows import with their stock and price and show in My products; the bad rows do not", async ({ browser }) => {
  const made = await freshShop("import");
  const cat = need(world().category, "the world's QA category").name;
  const ok = (n: number) => ({ "Product Name": `QA Import ${RUN} ${n}`, Category: cat, Brand: "QA", MRP: 50 + n, "Selling Price": 45 + n, "Stock Qty": 10 + n, Unit: "pcs", "Loose Item (Y/N)": "N", "GST %": 5 });
  const loose = { "Product Name": `QA Import ${RUN} loose dal`, Category: cat, "Selling Price": 120, "Stock Qty": 2.5, Unit: "kg", "Loose Item (Y/N)": "Y", "GST %": 0 };
  const name = `qa-import-commit-${RUN}.xlsx`;
  const bytes = await importWorkbook(PU_COLUMNS, [
    ok(1), ok(2), ok(3), ok(4), ok(5), loose,
    { ...ok(7), MRP: null },
    { ...ok(8), MRP: 500, "Selling Price": 550 },
    { ...ok(9), "Stock Qty": -5 },
    { ...ok(10), "Product Name": null },
  ], name);
  const job = await importPreview(made.ctx, made.shop.id, name, bytes);
  expect(job.status, job.errorMessage ?? "").toBe("preview_ready");
  const preview = await importRows(made.ctx, job.id);
  expect(preview.filter((r) => r.status === "failed").map((r) => r.rowNumber), "rows 8–11 rejected").toEqual([8, 9, 10, 11]);
  const commit = await call(made.ctx, "POST", `/api/v1/product-imports/${job.id}/commit`, { inventoryMode: "SET" });
  expectStatus(commit, 202, "import the valid rows");
  const done = await waitImportJob(made.ctx, job.id, (s) => s === "completed" || s === "failed");
  expect(done.status).toBe("completed");
  expect(done.counts.created, "6 rows created").toBe(6);

  const listings = await setupListings(made.ctx, made.shop.id);
  const named = (n: string) => listings.find((l) => l.product.name === n);
  for (let n = 1; n <= 5; n++) {
    const l = need(named(`QA Import ${RUN} ${n}`), `row ${n} imported`);
    expect({ price: l.onlinePricePaise, stock: Number(l.onlineStock) }).toEqual({ price: (45 + n) * 100, stock: 10 + n });
  }
  const dal = need(named(loose["Product Name"]), "the loose row imported");
  expect({ kind: dal.product.kind, mrp: dal.product.mrpPaise, price: dal.onlinePricePaise, stock: Number(dal.onlineStock) }).toEqual({ kind: "LOOSE", mrp: null, price: 12000, stock: 2.5 });
  for (const n of [7, 8, 9]) expect(named(`QA Import ${RUN} ${n}`), `bad row ${n} not imported`).toBeUndefined();

  const { context, page } = await pageFor(browser, made.owner);
  try {
    await page.goto("/shop/my-products");
    for (const n of [1, 5]) {
      const row = await stockRow(page, `QA Import ${RUN} ${n}`);
      await expect(row.getByLabel(`Selling price (₹) for QA Import ${RUN} ${n}`)).toHaveValue(String(45 + n));
      await expect(row.getByLabel(`Stock for QA Import ${RUN} ${n}`)).toHaveValue(String(10 + n));
    }
    await stockRow(page, loose["Product Name"]);
  } finally {
    await context.close();
  }
  return `preview: rows 8–11 rejected; import created 6 (5 packaged at their price and stock, the loose dal without MRP at ₹120 × 2.5 kg); My products shows them`;
}, { ...local, partial: "the template's drop-downs and the page's error filter / error download are covered by the signed check on the same cases" });

/* ---------------------------------------------------------- setup Excel */

qa(["TC-CAT-083", "TC-CAT-084"], "setup file: a product in a category the shop does not carry → 'Add the category \"X\" to your shop first.'; an 11 MB file → 'The file is too large. The limit is 10 MB.' and nothing stored", async () => {
  const made = await freshShop("setupxl");
  const elsewhere = await newCategory("Elsewhere");
  const product = await newMasterProduct({ name: `QA Elsewhere ${RUN}`, mrpPaise: 4000, categoryId: elsewhere.id });
  const name = `qa-setup-category-${RUN}.xlsx`;
  const up = await uploadSetupFile(made.ctx, made.shop.id, name, await workbook(SETUP_HEADERS, [[product.code, null, null, null, null, null, null, "Yes", null, 35, 4]], name));
  expectStatus(up, 202, "upload the setup file");
  const view = await settledUpload(made.ctx, made.shop.id, up.body.uploadId);
  expect(view.errors.map((e) => `Row ${e.row}: ${e.message}`)).toEqual([`Row 2: Add the category "${elsewhere.name}" to your shop first.`]);
  await call(made.ctx, "POST", `/api/shops/${made.shop.id}/product-setup/uploads/${up.body.uploadId}/cancel`);

  const big = Buffer.alloc(11 * 1024 * 1024, 0x41);
  const tooBig = await uploadSetupFile(made.ctx, made.shop.id, `qa-setup-11mb-${RUN}.xlsx`, big);
  expect(tooBig.status, why(tooBig)).toBe(422);
  expect(tooBig.body?.error?.message).toBe("The file is too large. The limit is 10 MB.");
  const history = await call(made.ctx, "GET", `/api/shops/${made.shop.id}/product-setup/uploads`);
  expect(((history.body.uploads ?? []) as { fileName: string }[]).map((u) => u.fileName), "the 11 MB file is not stored").toEqual([name]);
  return `"${view.errors[0]?.message}"; 11 MB → 422 "${tooBig.body?.error?.message}"`;
}, { ...local, partial: "the other row errors, 5,000 / 5,001 rows and the same file twice are the signed checks (they run here too)" });

/* ------------------------------------------------- starter shelf, barcodes */

qa("TC-CAT-086", "starter shelf (registration step 7): up to 100 products, ranked by orders in 90 days then shops stocking them, ticked at MRP with stock 100; 'Publish N products' makes N Live listings", async ({ browser }) => {
  const s = await shelfShop("rank", 3);
  const api = await shelfApi(s.ctx, s.shop.id);
  expect(api.defaultStock).toBe(100);
  expect(api.items.length, "at most 100").toBeLessThanOrEqual(100);
  for (const p of s.items) expect(api.items.map((i) => i.productId), `${p.name} on the shelf`).toContain(p.id);
  const signals = await shelfSignals(api.items.map((i) => i.productId));
  for (let i = 1; i < api.items.length; i++) {
    const a = signals.get(api.items[i - 1].productId)!;
    const b = signals.get(api.items[i].productId)!;
    expect(a.ordered > b.ordered || (a.ordered === b.ordered && a.stocked >= b.stocked), `${api.items[i - 1].name} (${a.ordered} orders, ${a.stocked} shops) before ${api.items[i].name} (${b.ordered}, ${b.stocked})`).toBe(true);
  }
  const { context, page } = await pageFor(browser, s.owner);
  let ticked = 0;
  try {
    const shelf = await openStarterShelf(page);
    const list = shelf.getByRole("listitem");
    await expect(list).toHaveCount(api.items.length);
    for (const [i, item] of api.items.entries()) {
      const li = list.nth(i);
      await expect(li).toContainText(item.name);
      if (item.mrpPaise != null) {
        ticked += 1;
        await expect(li.getByRole("checkbox")).toBeChecked();
        await expect(li.getByLabel(`Price of ${item.name}`)).toHaveValue(rupees(item.mrpPaise));
      } else {
        await expect(li.getByRole("checkbox"), "a loose product starts unticked").not.toBeChecked();
      }
      await expect(li.getByLabel(`Quantity of ${item.name}`)).toHaveValue("100");
    }
    await expect(shelf).toContainText(`${ticked} of ${api.items.length} products ticked.`);
    await shelf.getByRole("button", { name: `Publish ${ticked} products` }).click();
    await expect(page.getByText(/Registration successful/).first()).toBeVisible({ timeout: 120_000 });
  } finally {
    await context.close();
  }
  const listings = await setupListings(s.ctx, s.shop.id);
  expect(listings.length, "N listings").toBe(ticked);
  expect(listings.filter((l) => statusOf(l) !== "LIVE").map((l) => l.product.name), "all Live").toEqual([]);
  for (const p of s.items) {
    const l = need(listings.find((x) => x.productId === p.id), `${p.name} listed`);
    expect({ price: l.onlinePricePaise, stock: Number(l.onlineStock) }).toEqual({ price: l.product.mrpPaise, stock: 100 });
  }
  return `${api.items.length} offered in rank order, ${ticked} ticked at MRP × 100 → ${listings.length} Live listings`;
}, local);

qa("TC-CAT-087", "starter shelf: with nothing ticked 'Publish 0 products' is disabled (the API answers 'Tick at least one product.'); a ticked product with its price cleared → 'Enter a price for X, or untick it.'", async ({ browser }) => {
  const s = await shelfShop("tick", 2);
  const { context, page } = await pageFor(browser, s.owner);
  try {
    const shelf = await openStarterShelf(page);
    const checked = shelf.getByRole("listitem").getByRole("checkbox", { checked: true });
    for (let i = 0; i < 250 && (await checked.count()); i++) await checked.first().uncheck();
    await expect(shelf.getByRole("button", { name: "Publish 0 products" })).toBeDisabled();
    const none = await call(s.ctx, "POST", `/api/shops/${s.shop.id}/starter-shelf`, { items: [] });
    expect(none.status, why(none)).toBe(422);
    expect(JSON.stringify(none.body)).toContain("Tick at least one product.");
    const item = s.items[0];
    const li = shelf.getByRole("listitem").filter({ hasText: item.name });
    await li.getByRole("checkbox").check();
    await li.getByLabel(`Price of ${item.name}`).fill("");
    await shelf.getByRole("button", { name: "Publish 1 products" }).click();
    await expect(shelf.getByText(`Enter a price for ${item.name}, or untick it.`, { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
  expect((await setupListings(s.ctx, s.shop.id)).length, "nothing listed").toBe(0);
  return `nothing ticked: Publish disabled, API 422 "Tick at least one product."; price cleared: "Enter a price for ${s.items[0].name}, or untick it."`;
}, local);

qa("TC-CAT-088", "a known barcode typed into the scanner: 'Added X at MRP ₹45.', the pack goes to the top of the shelf ticked, and after publishing it is Live in My products", async ({ browser }) => {
  const s = await shelfShop("scan", 1);
  const other = await newCategory("Scanned");
  const pack = await productWithBarcode(other.id, 4500);
  const { context, page } = await pageFor(browser, s.owner);
  try {
    const shelf = await openStarterShelf(page);
    await typeBarcode(page, pack.barcode);
    await expect(page.getByRole("status").filter({ hasText: `Added ${pack.name} at MRP ₹45.` }).first()).toBeVisible();
    const first = shelf.getByRole("listitem").first();
    await expect(first).toContainText(pack.name);
    await expect(first.getByRole("checkbox")).toBeChecked();
    await expect(first.getByLabel(`Price of ${pack.name}`)).toHaveValue("45");
    await shelf.getByRole("button", { name: /^Publish \d+ products$/ }).click();
    await expect.poll(async () => (await setupListings(s.ctx, s.shop.id)).some((l) => l.productId === pack.id), { timeout: 60_000 }).toBe(true);
    await page.goto("/shop/my-products?status=LIVE");
    const row = await stockRow(page, pack.name);
    await expect(row.getByLabel(`Selling price (₹) for ${pack.name}`)).toHaveValue("45");
  } finally {
    await context.close();
  }
  const l = need((await setupListings(s.ctx, s.shop.id)).find((x) => x.productId === pack.id), "the scanned pack's listing");
  expect(statusOf(l)).toBe("LIVE");
  return `${pack.barcode} → "Added ${pack.name} at MRP ₹45." → published → Live at ₹45 in My products`;
}, { ...local, partial: "the barcode is typed into the scanner's number field; reading it with a phone camera is manual" });

qa("TC-CAT-089", "an unknown barcode: '<code> is not in our catalogue yet…', name / unit / price sent → 'Sent to our team — it goes on sale in your shop once approved.' and the admin's queue has it; a 5-digit code is not looked up (API: 'Enter the barcode number (at least 6 digits).')", async ({ browser }) => {
  const s = await shelfShop("unknown", 1);
  const code = `66${String(Date.now()).slice(-10)}`;
  const productName = `QA Unknown pack ${RUN}`;
  const { context, page } = await pageFor(browser, s.owner);
  try {
    await openStarterShelf(page);
    await typeBarcode(page, code);
    const form = page.getByTestId("shelf-new-product");
    await expect(form).toContainText(`${code} is not in our catalogue yet. Add it — it goes on sale once our team approves it.`);
    await form.getByLabel("Product name").fill(productName);
    await form.getByLabel("Unit").selectOption("piece");
    await form.getByLabel("Selling price").fill("25");
    await form.getByRole("button", { name: "Add product" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sent to our team — it goes on sale in your shop once approved. We'll let you know." }).first()).toBeVisible();

    const lookups: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/barcode-lookup")) lookups.push(r.url());
    });
    await typeBarcode(page, "12345");
    await expect(page.getByTestId("barcode-scanner"), "the scanner stays open: nothing was looked up").toBeVisible();
    expect(lookups, "no look-up for 5 digits").toEqual([]);
  } finally {
    await context.close();
  }
  const short = await call(s.ctx, "GET", `/api/shops/${s.shop.id}/barcode-lookup?code=12345`);
  expect(short.status, why(short)).toBe(422);
  expect(short.body?.error?.message).toBe("Enter the barcode number (at least 6 digits).");
  const queue = await call(await as("admin"), "GET", "/api/products/pending-approval");
  expectStatus(queue, 200, "the admin's approval queue");
  const pending = ((queue.body.products ?? []) as { name: string; barcode: string | null }[]).find((p) => p.barcode === code);
  expect(pending?.name, "the admin sees the request").toBe(productName);
  const admin = await pageAs(browser, "admin");
  try {
    await admin.page.goto("/admin/console/product-approvals");
    await expect(admin.page.getByText(productName).first()).toBeVisible();
  } finally {
    await admin.context.close();
  }
  return `${code}: not in the catalogue → sent; admin queue lists "${productName}"; 12345: no look-up on the page, API 422`;
}, local);

/* --------------------------------------------------- how you deliver */

qa(["TC-CAT-090", "TC-CAT-091"], "How do you deliver?: own staff at 3 km saved → a customer 4 km away cannot get delivery (2 km can); Pickup only saved → 'Pickup only' on the shop page, no delivery fee, the order needs no delivery address", async ({ browser }) => {
  const made = await sellingShop("deliver");
  const item = { shopProductId: made.listing.shopProductId, name: made.listing.name };
  const { context, page } = await pageFor(browser, made.owner);
  const out: string[] = [];
  try {
    await page.goto("/shop/setup/delivery");
    await expect(page.getByRole("heading", { name: "How do you deliver?" })).toBeVisible();
    await page.getByRole("radio", { name: /My own delivery staff/ }).check();
    const slider = page.getByTestId("delivery-radius");
    await expect(slider).toHaveAttribute("min", "1");
    await expect(slider).toHaveAttribute("max", "10");
    await slider.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Deliver up to (km from your shop): 3 km")).toBeVisible();
    await page.getByTestId("delivery-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. Customers now see how you deliver." }).first()).toBeVisible();
    const [own] = await db()<{ delivery_choice: string; service_radius_km: number; delivery_available: boolean }[]>`select delivery_choice, service_radius_km, delivery_available from shops where id = ${made.shop.id}`;
    expect(own).toEqual({ delivery_choice: "OWN_STAFF", service_radius_km: 3, delivery_available: true });

    await withAddresses("customer", [
      { ...pointNorth(2), line1: `QA 2 km ${RUN}`, label: `QA 2 km ${RUN}` },
      { ...pointNorth(4), line1: `QA 4 km ${RUN}`, label: `QA 4 km ${RUN}` },
    ], async ([near, far]) => {
      await fillCart("customer", [{ item, quantity: 1 }]);
      const a = need((await validateCart("customer", near.id)).shops.find((x) => x.shopId === made.shop.id), "the shop in the cart check");
      const b = need((await validateCart("customer", far.id)).shops.find((x) => x.shopId === made.shop.id), "the shop in the cart check");
      expect(a.issues.map((i) => i.code), "2 km: delivered").not.toContain("NOT_DELIVERABLE");
      expect(b.issues.find((i) => i.code === "NOT_DELIVERABLE")?.message, "4 km: no delivery").toMatch(/does not deliver/);
      out.push(`own staff 3 km: 2 km delivered, 4 km "${b.issues.find((i) => i.code === "NOT_DELIVERABLE")?.message}"`);

      await page.getByRole("radio", { name: /Pickup only/ }).check();
      await expect(page.getByTestId("delivery-radius")).toHaveCount(0);
      await page.getByTestId("delivery-save").click();
      await expect(page.getByRole("status").filter({ hasText: "Saved. Customers now see how you deliver." }).first()).toBeVisible();
      const [pickup] = await db()<{ delivery_choice: string; delivery_available: boolean }[]>`select delivery_choice, delivery_available from shops where id = ${made.shop.id}`;
      expect(pickup).toEqual({ delivery_choice: "PICKUP_ONLY", delivery_available: false });
      const c = need((await validateCart("customer", far.id)).shops.find((x) => x.shopId === made.shop.id), "the shop in the cart check");
      expect(c.issues.map((i) => i.code), "pickup: distance does not matter").not.toContain("NOT_DELIVERABLE");
      expect(c.deliveryFeePaise, "pickup: no delivery fee").toBe(0);
    });

    const shopper = await pageAs(browser, "customer");
    try {
      const [{ slug }] = await db()<{ slug: string }[]>`select slug from shops where id = ${made.shop.id}`;
      await shopper.page.goto(`/shops/${slug}`);
      await expect(shopper.page.getByTestId("shop-delivery-line")).toContainText("Pickup only");
    } finally {
      await shopper.context.close();
    }

    await fillCart("customer", [{ item, quantity: 1 }]);
    const order = await checkoutAs("customer", { addressId: null, paymentMethod: "WALLET", acknowledgeClosedShopIds: [made.shop.id] });
    if ([409, 422].includes(order.status)) blocked(`checkout refused — ${why(order)}`);
    expectStatus(order, 201, "a pickup order without a delivery address");
    const placed = need(order.body.orders?.[0]?.id as string | undefined, "the order id");
    const [row] = await db()<{ delivery_fee_paise: number; delivery_address_snapshot: unknown }[]>`select delivery_fee_paise, delivery_address_snapshot from orders where id = ${placed}`;
    expect({ fee: Number(row.delivery_fee_paise), address: row.delivery_address_snapshot }).toEqual({ fee: 0, address: null });
    out.push(`pickup only: shop page "Pickup only", fee ₹0, order ${placed} placed without an address`);
  } finally {
    await context.close();
    await clearCart("customer").catch(() => undefined);
  }
  return out.join("; ");
}, local);
