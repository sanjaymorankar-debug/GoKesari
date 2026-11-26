/**
 * Group C (20-Nov-2026): "Set up your shop's products" and My products (statuses, filters,
 * the stock and price editor, phone layout and shop switcher), the product import template
 * and its row errors, "Update many products with Excel", the starter shelf and barcode
 * look-up API, "How you deliver" and the shop logo address — as shop A's owner and the
 * test customer meet them. Signed-in tier: test.gokesari.com and the local server.
 *
 * Shop A's own listings (the world's milk, premium, lowStock, packaged, sharedA…) are never
 * changed: listing writes work on throw-away listings (products of A's categories it did not
 * list, picked through the setup API and removed again — lib/product-setup-helpers
 * withThrowAway). Product-import and setup-file previews that would touch A's listings are
 * cancelled, never imported. Shop settings changed for a check (radius, logo) are put back in
 * a finally block.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { as, pageAs } from "../lib/actors";
import { cartLines, emptyCart, shopOf } from "../lib/flows";
import { call, expectStatus, RUN, stash, unstash, why } from "../lib/http";
import {
  arrangeStates,
  cancelImport,
  cancelSetupUpload,
  cellText,
  COL,
  DESKTOP,
  downloadFrom,
  importRows,
  importWorkbook,
  knownCategory,
  latestImportNamed,
  latestUploadNamed,
  loadWorkbook,
  PHONE,
  PU_COLUMNS,
  saveListings,
  settledUpload,
  SETUP_HEADERS,
  setupListings,
  sheetRows,
  STATUS_LABEL,
  STATUSES,
  statusOf,
  stockRow,
  uploadSetupFile,
  withThrowAway,
  workbook,
  XLSX_TYPE,
  type ListingStatus,
  type ThrowAway,
} from "../lib/product-setup-helpers";
import { blocked, expect, need, qa } from "../lib/record";
import { FILE_DIR, RUN_KEY } from "../lib/sellers-helpers";
import { clearCart, fillCart, pointNorth, validateCart, withAddresses } from "../lib/shopping-helpers";
import { world } from "../lib/world";

const signed = { tier: "signed" as const, timeout: 420_000 };
const KEY = "sellers-product-setup-signed";

async function ownerView(ctx: APIRequestContext, shopId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}`);
  expectStatus(res, 200, "the owner's view of shop A");
  return res.body as { deliveryChoice: string | null; deliveryAvailable: boolean; serviceRadiusKm: number; logoUrl: string | null; name: string };
}

/** The owner's "Download my products" file of a shop, through the API (for codes only). */
async function myProductsFile(ctx: APIRequestContext, shopId: string): Promise<string[][]> {
  const res = await ctx.get(`/api/shops/${shopId}/product-setup/download?kind=mine&format=xlsx`, { failOnStatusCode: false, timeout: 120_000 });
  expect(res.status(), "download my products").toBe(200);
  return sheetRows(await res.body(), "Products");
}

/* ------------------------------------------------- guided set-up, statuses */

qa("TC-CAT-071", "guided set-up on shop A: 'Step 1 of 3: Choose categories', 'Step 2 of 3: Add products' offering 'Select products on screen' (Recommended on a phone) and 'Add in bulk with Excel', 'Step 3 of 3: Set stock and price'", async ({ browser }) => {
  const seen: string[] = [];
  for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    const { context, page } = await pageAs(browser, "shop", { viewport });
    try {
      await page.goto("/shop/product-categories?step=1");
      const progress = page.getByTestId("setup-progress");
      await expect(progress).toContainText("Step 1 of 3: Choose categories");
      await expect(page.getByRole("heading", { name: "What does your shop sell?" })).toBeVisible();
      await expect(page.getByTestId("category-tiles")).toBeVisible();
      await page.goto("/shop/product-categories?step=2");
      if (await page.getByTestId("setup-empty").count()) blocked("shop A carries no product category on this site (the page starts at 'Start by choosing what your shop sells')");
      await expect(progress).toContainText("Step 2 of 3: Add products");
      const choice = page.getByTestId("add-choice");
      await expect(choice.getByRole("link", { name: /Select products on screen/ })).toBeVisible();
      await expect(choice.getByRole("link", { name: /Add in bulk with Excel/ })).toBeVisible();
      const recommended = choice.getByText("Recommended", { exact: true });
      if (label === "phone") await expect(recommended).toBeVisible();
      else await expect(recommended).toBeHidden();
      await page.goto("/shop/product-categories?step=3");
      await expect(progress).toContainText("Step 3 of 3: Set stock and price");
      seen.push(`${label}: three steps, Recommended ${label === "phone" ? "shown" : "hidden"}`);
    } finally {
      await context.close();
    }
  }
  return seen.join("; ");
}, { ...signed, partial: "choosing two categories, ticking 5 products, going live and the Excel path on a shop with no products run in tests/qa/local/sellers-product-setup.spec.ts (a fresh shop)" });

qa("TC-CAT-072", "My products: Live, Needs Stock, Needs Price, Out of Stock and Paused chips each show only their listings, and their counts add up to All", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  return withThrowAway(owner, shop.id, 5, async (rows) => {
    const by = await arrangeStates(owner, shop.id, rows);
    const listings = await setupListings(owner, shop.id);
    const api = Object.fromEntries(STATUSES.map((s) => [s, listings.filter((l) => statusOf(l) === s).length])) as Record<ListingStatus, number>;
    const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
    try {
      await page.goto("/shop/my-products");
      const nav = page.getByRole("navigation", { name: "Filter by status" });
      const chip = (label: string) => nav.getByRole("link", { name: new RegExp(`^${label} \\(\\d+\\)$`) });
      const countOf = async (label: string) => Number((await chip(label).innerText()).match(/\((\d+)\)/)?.[1] ?? NaN);
      const all = await countOf("All");
      const counts = {} as Record<ListingStatus, number>;
      for (const s of STATUSES) counts[s] = await countOf(STATUS_LABEL[s]);
      expect(STATUSES.reduce((n, s) => n + counts[s], 0), "the five chips add up to All").toBe(all);
      expect(all, "All counts every listing").toBe(listings.length);
      expect(counts, "chip counts agree with the listings' statuses").toEqual(api);
      for (const s of STATUSES) {
        await chip(STATUS_LABEL[s]).click();
        await expect(page).toHaveURL(new RegExp(`status=${s}`));
        await expect(chip(STATUS_LABEL[s])).toHaveAttribute("aria-current", "page");
        const shown = page.getByTestId("stock-row");
        await expect(shown).toHaveCount(Math.min(counts[s], 25));
        await expect(shown.filter({ has: page.getByText(STATUS_LABEL[s], { exact: true }) }), `every row under ${STATUS_LABEL[s]} carries that status`).toHaveCount(Math.min(counts[s], 25));
        await stockRow(page, by[s].name);
      }
    } finally {
      await context.close();
    }
    return `All ${listings.length} = ${STATUSES.map((s) => `${STATUS_LABEL[s]} ${api[s]}`).join(" + ")}; each chip lists only its own (throw-away ${STATUSES.map((s) => by[s].name).join(", ")})`;
  });
}, signed);

qa("TC-CAT-073", "customers see only Live listings: shop page, search, Compare prices and GET /api/shops/<A>/products leave out Needs Stock, Needs Price, Out of Stock and Paused, and none of them can be put in the cart", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const customer = await as("customer");
  return withThrowAway(owner, shop.id, 5, async (rows) => {
    const by = await arrangeStates(owner, shop.id, rows);
    const hidden = STATUSES.filter((s) => s !== "LIVE");
    // The API a customer's app reads.
    const ids = new Set<string>();
    for (let offset = 0; offset < 3000; offset += 100) {
      const res = await call(customer, "GET", `/api/shops/${shop.id}/products?limit=100&offset=${offset}`);
      expectStatus(res, 200, "shop A's products as a customer");
      const list = res.body as { shopProductId: string; inStock: boolean; onlinePricePaise: number | null; productName: string }[];
      for (const r of list) {
        ids.add(r.shopProductId);
        expect(r.inStock, `${r.productName} is offered while not in stock`).toBe(true);
        expect(r.onlinePricePaise, `${r.productName} is offered without a price`).not.toBeNull();
      }
      if (list.length < 100) break;
    }
    expect(ids.has(by.LIVE.shopProductId), "the Live listing is in the API").toBe(true);
    for (const s of hidden) expect(ids.has(by[s].shopProductId), `the ${STATUS_LABEL[s]} listing is in the API`).toBe(false);

    // Not orderable.
    const refusals: string[] = [];
    for (const s of hidden) {
      const res = await call(customer, "POST", "/api/cart", { shopProductId: by[s].shopProductId, quantity: 1 });
      refusals.push(`${STATUS_LABEL[s]} ${res.status} "${res.body?.error?.message ?? ""}"`);
    }
    const carted = (await cartLines("customer")).filter((l) => hidden.some((s) => by[s].shopProductId === l.shopProductId));
    if (carted.length) await emptyCart("customer");
    expect(carted.map((l) => l.shopProductId), `added to the cart: ${refusals.join("; ")}`).toEqual([]);
    for (const r of refusals) expect(r, "a refusal (4xx)").toMatch(/ 4\d\d /);

    // The pages.
    const { context, page } = await pageAs(browser, "customer");
    try {
      const onShopPage = async (item: ThrowAway) => {
        const names = new Set<string>();
        for (let p = 1; p <= 6; p++) {
          await page.goto(`/shops/${shop.slug}?cat=${encodeURIComponent(item.categoryName)}&page=${p}`);
          const before = names.size;
          for (const text of await page.getByTestId("product-card").allInnerTexts()) names.add(text);
          if (names.size === before) break;
        }
        return [...names].some((t) => t.includes(item.name));
      };
      expect(await onShopPage(by.LIVE), "the Live listing is on shop A's page").toBe(true);
      for (const s of hidden) expect(await onShopPage(by[s]), `the ${STATUS_LABEL[s]} listing is on shop A's page`).toBe(false);

      const inSearch = (item: ThrowAway) => page.getByTestId("product-card").filter({ hasText: shop.name }).filter({ hasText: item.name });
      await page.goto(`/search?q=${encodeURIComponent(by.LIVE.name)}`);
      await expect(inSearch(by.LIVE).first(), "the Live listing in search").toBeVisible();
      for (const s of hidden) {
        await page.goto(`/search?q=${encodeURIComponent(by[s].name)}`);
        await expect(inSearch(by[s]), `the ${STATUS_LABEL[s]} listing in search`).toHaveCount(0);
      }

      await page.goto(`/products/${by.LIVE.productId}`);
      await expect(page.getByTestId("price-comparison").getByRole("link", { name: shop.name })).toBeVisible();
      const compare: string[] = [];
      for (const s of hidden) {
        const res = await page.goto(`/products/${by[s].productId}`);
        if (res?.status() === 404) {
          compare.push(`${STATUS_LABEL[s]}: product page 404 (no shop sells it live)`);
          continue;
        }
        await expect(page.getByTestId("price-comparison").getByRole("link", { name: shop.name }), `shop A in Compare prices for the ${STATUS_LABEL[s]} listing`).toHaveCount(0);
        compare.push(`${STATUS_LABEL[s]}: not in Compare prices`);
      }
      return `API, shop page, search and Compare prices show only the Live one; cart: ${refusals.join("; ")}; ${compare.join(", ")}`;
    } finally {
      await context.close();
    }
  });
}, signed);

qa("TC-CAT-074", "the stock and price editor refuses MRP 0, a price above the MRP, a discount of 0% or 100% and a price over ₹10,00,000, and saves nothing for them", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  return withThrowAway(owner, shop.id, 1, async ([item]) => {
    // Out of Stock keeps the filtered list short.
    expectStatus(await saveListings(owner, shop.id, [{ shopProductId: item.shopProductId, pricePaise: item.mrpPaise, stock: 0 }]), 200, "price the throw-away listing");
    const mrp = String(item.mrpPaise / 100);
    const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
    try {
      await page.goto("/shop/my-products?status=OUT_OF_STOCK");
      let row = await stockRow(page, item.name);
      const save = page.getByRole("button", { name: "Save changes" });
      const mrpBox = () => row.getByLabel(`MRP (₹) for ${item.name}`);
      const priceBox = () => row.getByLabel(`Selling price (₹) for ${item.name}`);
      await expect(mrpBox()).toHaveValue(mrp);

      await mrpBox().fill("0");
      await expect(row.getByText("MRP must be more than 0.", { exact: true })).toBeVisible();
      await expect(save).toBeDisabled();
      await mrpBox().fill(mrp);
      await priceBox().fill(String(item.mrpPaise / 100 + 1));
      await expect(row.getByText("Price cannot be more than the MRP.", { exact: true })).toBeVisible();
      await expect(save).toBeDisabled();

      const discount = page.getByLabel("Discount off MRP (%)");
      const applyDiscount = discount.locator("xpath=ancestor::div[1]").getByRole("button", { name: "Apply" });
      for (const pct of ["0", "100"]) {
        await page.reload();
        row = await stockRow(page, item.name);
        await row.getByLabel(`Select ${item.name}`, { exact: true }).check(); // the bulk tools show once a row is picked
        await discount.fill(pct);
        await applyDiscount.click();
        await expect(page.getByText("Enter a discount from 1 to 99 percent.", { exact: true }), `discount ${pct}%`).toBeVisible();
        await expect(priceBox(), `discount ${pct}% changes no price`).toHaveValue(mrp);
      }

      await page.reload();
      row = await stockRow(page, item.name);
      await mrpBox().fill("1000001");
      await priceBox().fill("1000001");
      await expect(save).toBeEnabled();
      await save.click();
      await expect(row.getByText("A price can be at most ₹10,00,000.", { exact: true })).toBeVisible();
      await expect(page.getByText("1 product was not saved. Look for the messages in red.", { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
    const after = need((await setupListings(owner, shop.id)).find((l) => l.id === item.shopProductId), "the throw-away listing");
    expect(after.onlinePricePaise, "the price is unchanged").toBe(item.mrpPaise);
    expect(Number(after.onlineStock), "the stock is unchanged").toBe(0);
    return `MRP 0, price above MRP, discount 0 / 100 refused on the page (Save disabled); MRP and price 10,00,001 → "A price can be at most ₹10,00,000."; ${item.name} still ₹${mrp}, stock 0`;
  });
}, signed);

qa("TC-CAT-075", "D-2: on a phone the shop list no longer sits above the set-up steps; D-3: a link with ?shop=<second shop> keeps that shop in the top-bar switcher on later pages", async ({ browser }) => {
  const shop = await shopOf("A");
  const desktop = await pageAs(browser, "shop", { viewport: DESKTOP });
  let others: { id: string; name: string }[] = [];
  try {
    await desktop.page.goto("/shop/product-categories");
    const options = await desktop.page.getByTestId("shop-switcher-option").evaluateAll((els) => els.map((e) => ({ id: (e as HTMLButtonElement).value, name: (e.textContent ?? "").trim() })));
    others = options.filter((o, i) => o.id !== shop.id && options.findIndex((x) => x.id === o.id) === i);
    if (!others.length) blocked("the test shop owner has only one shop on this site (D-2 / D-3 need two)");
    await expect(desktop.page.getByRole("navigation", { name: "Your shops" }), "desktop keeps the in-page shop list").toBeVisible();
  } finally {
    await desktop.context.close();
  }
  const second = others[0];
  const { context, page } = await pageAs(browser, "shop", { viewport: PHONE });
  try {
    await page.goto("/shop/product-categories");
    await expect(page.getByRole("navigation", { name: "Your shops" }), "D-2: no shop list on a phone").toBeHidden();
    await expect(page.getByTestId("setup-progress").or(page.getByTestId("setup-empty"))).toBeVisible();
    const box = await page.getByTestId("setup-progress").or(page.getByTestId("setup-empty")).boundingBox();
    expect(box?.y ?? 9999, "the steps start on the first screen").toBeLessThan(PHONE.height);

    await page.goto(`/shop/product-categories?shop=${second.id}`);
    const switcher = page.getByLabel(`Switch shop: ${second.name}`, { exact: true }).filter({ visible: true });
    await expect(switcher, "D-3: the top bar follows the linked shop").toBeVisible({ timeout: 60_000 });
    await page.goto("/shop/my-products");
    await expect(switcher, "D-3: still the second shop on a later page").toBeVisible();
    await expect(page.getByRole("heading", { name: "My products" }).locator("xpath=..")).toContainText(second.name);
  } finally {
    await context.close();
  }
  return `phone: no "Your shops" list, steps on the first screen; ?shop=${second.name} → switcher "${second.name}" on /shop/product-categories and /shop/my-products`;
}, signed);

/* ----------------------------------------------- product import template */

/** Uploads a product file on /shop/product-import and waits for the preview. */
async function previewOnPage(page: Page, name: string, bytes: Buffer) {
  await page.goto("/shop/product-import");
  await page.getByTestId("import-file-input").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: bytes });
  await page.getByTestId("upload-button").click();
  await expect(page.getByTestId("commit-button")).toBeVisible({ timeout: 180_000 });
  return page.getByTestId("import-rows-table");
}

qa("TC-CAT-076", "the import template (Download GoKesari template) has the Category drop-down, an Instructions sheet and a hidden, locked GoKesari Product ID", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  try {
    await page.goto("/shop/product-import");
    await expect(page.getByTestId("mandatory-columns")).toContainText("Mandatory on every row: Product Name, Category, MRP (not for loose items) and Stock Qty.");
    const file = await downloadFrom(page, page.getByTestId("download-template"));
    expect(file.name).toBe("GoKesari_Product_Upload_Template.xlsx");
    const wb = await loadWorkbook(file.bytes);
    const ws = need(wb.getWorksheet("Products"), "the Products sheet");
    const header = (ws.getRow(1).values as unknown[]).map((v) => cellText(v));
    for (const column of ["Product Name", "Category", "MRP", "Stock Qty", "GoKesari Product ID"]) expect(header, `column ${column}`).toContain(column);
    const category = String(ws.getCell(2, header.indexOf("Category")).dataValidation?.formulae?.[0] ?? "");
    expect(category, "Category is a drop-down of the category list").toMatch(/^Lists!\$A\$2:\$A\$\d+$/);
    expect(wb.getWorksheet("Lists")?.state, "the category list sheet is hidden").toBe("veryHidden");
    const instructions = need(wb.getWorksheet("Instructions"), "the Instructions sheet");
    expect(cellText(instructions.getCell(1, 1).value)).toBe("GoKesari bulk product upload — instructions");
    const idCol = ws.getColumn(header.indexOf("GoKesari Product ID"));
    expect(idCol.hidden, "GoKesari Product ID is hidden").toBe(true);
    expect((ws as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet, "the sheet is protected").toBe(true);
    expect(idCol.style?.protection?.locked, "the Product ID column is not unlocked").not.toBe(false);
    expect(ws.getColumn(header.indexOf("Product Name")).style?.protection?.locked, "the other columns are open to edit").toBe(false);
    return `${file.name}: Category list ${category}, Instructions sheet, GoKesari Product ID hidden and locked (sheet protected)`;
  } finally {
    await context.close();
  }
}, { ...signed, partial: "importing 5 valid rows and seeing them in My products is the local check (a commit would add products to the catalogue of the test site)" });

qa("TC-CAT-077", "rows missing Product Name, Category, MRP (packaged) or Stock Qty are rejected with their row number ('Row 7: MRP missing'); the valid rows are still offered for import", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const cat = await knownCategory(owner);
  const ok = (n: number) => ({ "Product Name": `QA PU ${RUN} valid ${n}`, Category: cat, Brand: "QA", MRP: 50, "Selling Price": 45, "Stock Qty": 10, Unit: "pcs", "Loose Item (Y/N)": "N", "GST %": 5 });
  const name = `qa-pu-mandatory-${RUN}.xlsx`;
  const bytes = await importWorkbook(PU_COLUMNS, [
    ok(1), ok(2), ok(3),
    { ...ok(4), "Product Name": null },
    { ...ok(5), Category: null },
    { ...ok(6), MRP: null },
    { ...ok(7), "Stock Qty": null },
  ], name);
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  let jobId = "";
  try {
    const table = await previewOnPage(page, name, bytes);
    jobId = await latestImportNamed(owner, shop.id, name);
    const expected = ["Error: Row 5: Product Name missing", "Error: Row 6: Category missing", "Error: Row 7: MRP missing", "Error: Row 8: Stock Qty missing"];
    for (const m of expected) await expect(table).toContainText(m);
    await expect(page.getByText("4 rows have errors and will not be imported", { exact: true })).toBeVisible();
    await expect(page.getByTestId("commit-button")).toHaveText("Import 3 rows");
    const rows = await importRows(owner, jobId);
    expect(rows.filter((r) => r.status === "failed").map((r) => r.rowNumber)).toEqual([5, 6, 7, 8]);
    expect(rows.filter((r) => r.status === "ready").map((r) => r.rowNumber)).toEqual([2, 3, 4]);
    return `${expected.join("; ")}; rows 2–4 ready, "Import 3 rows"`;
  } finally {
    await context.close();
    if (jobId) await cancelImport(owner, jobId);
  }
}, { ...signed, partial: "the preview only (cancelled): the commit of the valid rows is the local check" });

qa(["TC-CAT-078", "TC-CAT-079"], "Selling 550 > MRP 500, price 0, MRP 'abc', stock -5, GST 10 and an unknown category are each rejected with their reason; the other rows are offered for import", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const cat = await knownCategory(owner);
  const unknown = `QA Nowhere ${RUN}`;
  const ok = (n: number) => ({ "Product Name": `QA PU ${RUN} value ${n}`, Category: cat, Brand: "QA", MRP: 50, "Selling Price": 45, "Stock Qty": 10, Unit: "pcs", "Loose Item (Y/N)": "N", "GST %": 5 });
  const name = `qa-pu-values-${RUN}.xlsx`;
  const bytes = await importWorkbook(PU_COLUMNS, [
    ok(1), ok(2),
    { ...ok(3), MRP: 500, "Selling Price": 550 },
    { ...ok(4), "Selling Price": 0 },
    { ...ok(5), MRP: "abc" },
    { ...ok(6), "Stock Qty": -5 },
    { ...ok(7), "GST %": 10 },
    { ...ok(8), Category: unknown },
  ], name);
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  let jobId = "";
  try {
    const table = await previewOnPage(page, name, bytes);
    jobId = await latestImportNamed(owner, shop.id, name);
    const expected = [
      "Error: Row 4: Selling Price ₹550.00 > MRP ₹500.00",
      "Error: Row 5: Selling Price must be more than 0",
      'Error: Row 6: MRP "abc" is not a valid amount (a number, 0 or more)',
      'Error: Row 7: Stock Qty "-5" is not a valid quantity (a number, 0 or more)',
      "Error: Row 8: GST 10% is not a GST rate in India (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40%)",
      `Error: Row 9: Invalid category "${unknown}" — choose one from the Category list`,
    ];
    for (const m of expected) await expect(table).toContainText(m);
    await expect(page.getByTestId("commit-button")).toHaveText("Import 2 rows");
    const rows = await importRows(owner, jobId);
    expect(rows.filter((r) => r.status === "failed").map((r) => r.rowNumber)).toEqual([4, 5, 6, 7, 8, 9]);
    return expected.join("; ");
  } finally {
    await context.close();
    if (jobId) await cancelImport(owner, jobId);
  }
}, { ...signed, partial: "the preview only (cancelled); the valid rows' commit is the local check. The case's 'Toys' is replaced by a name that is surely not a category" });

qa(["TC-CAT-080", "TC-CAT-081"], "8 valid rows (one loose, no MRP) and 4 bad: 'Import 8 rows', 'Only rows with errors' shows the 4, 'Download rows with errors (Excel)' holds just them with an Error column", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const cat = await knownCategory(owner);
  const ok = (n: number) => ({ "Product Name": `QA PU ${RUN} partial ${n}`, Category: cat, Brand: "QA", MRP: 60, "Selling Price": 55, "Stock Qty": 12, Unit: "pcs", "Loose Item (Y/N)": "N", "GST %": 5 });
  const loose = { "Product Name": `QA PU ${RUN} loose rice`, Category: cat, "Selling Price": 40, "Stock Qty": 2.5, Unit: "kg", "Loose Item (Y/N)": "Y", "GST %": 0 };
  const name = `qa-pu-partial-${RUN}.xlsx`;
  const bytes = await importWorkbook(PU_COLUMNS, [
    ok(1), ok(2), ok(3), ok(4), ok(5), ok(6), ok(7), loose,
    { ...ok(9), MRP: null },
    { ...ok(10), "Selling Price": 70 },
    { ...ok(11), "Stock Qty": -1 },
    { ...ok(12), "Product Name": null },
  ], name);
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  let jobId = "";
  try {
    const table = await previewOnPage(page, name, bytes);
    jobId = await latestImportNamed(owner, shop.id, name);
    await expect(page.getByTestId("commit-button")).toHaveText("Import 8 rows");
    const rows = await importRows(owner, jobId);
    const looseRow = need(rows.find((r) => r.rowNumber === 9), "the loose row");
    expect(looseRow.status, `the loose row: ${looseRow.messages.join(" | ")}`).toBe("ready");
    expect(looseRow.messages.join(" "), "no MRP needed for a loose item").not.toMatch(/MRP missing/);
    await page.getByTestId("errors-only").check();
    await expect(table.getByRole("row")).toHaveCount(5);
    for (const n of [10, 11, 12, 13]) await expect(table).toContainText(`Error: Row ${n}:`);
    const report = await downloadFrom(page, page.getByTestId("error-report"));
    const sheet = await sheetRows(report.bytes);
    const head = sheet[0];
    const errorCol = head.indexOf("Error");
    expect(errorCol, "an Error column").toBeGreaterThan(0);
    expect(sheet.slice(1).map((r) => Number(r[0])), "just the 4 rows with errors").toEqual([10, 11, 12, 13]);
    for (const r of sheet.slice(1)) expect(r[errorCol], `row ${r[0]} has its reason`).toMatch(/^Row \d+: /);
    return `loose row ready without MRP; filter → 4 rows; ${report.name}: rows ${sheet.slice(1).map((r) => r[0]).join(", ")} with "${sheet[1][errorCol]}"…`;
  } finally {
    await context.close();
    if (jobId) await cancelImport(owner, jobId);
  }
}, { ...signed, partial: "the preview only (cancelled): the 8 rows' import and the loose listing are the local check" });

/* ------------------------------------------- Update many products with Excel */

const SAME_FILE = `${KEY}-same-file`;

/** A setup row from the downloaded file with numbers as numbers. */
const NUMERIC_COLUMNS = new Set<number>([COL.masterMrp, COL.shopMrp, COL.price, COL.stock]);
function asCells(row: string[]): (string | number | null)[] {
  return row.map((v, i) => (v === "" ? null : NUMERIC_COLUMNS.has(i) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v));
}

qa("TC-CAT-082", "Update many products with Excel: the file has the 11 columns; 3 price/stock changes apply and the Include = No product is paused (after ticking 'Yes, pause 1 product…') with 'Import valid rows and skip errors'", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  return withThrowAway(owner, shop.id, 5, async (items) => {
    expectStatus(await saveListings(owner, shop.id, items.map((i) => ({ shopProductId: i.shopProductId, pricePaise: i.mrpPaise, stock: 5 }))), 200, "put the throw-away listings live");
    const codes = new Map(items.map((i) => [i.code.toUpperCase(), i]));
    const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
    const name = `qa-update-many-${RUN}.xlsx`;
    try {
      await page.goto("/shop/my-products");
      await page.getByText("Update many products with Excel", { exact: true }).click();
      const file = await downloadFrom(page, page.getByRole("link", { name: "Download my products" }));
      const rows = await sheetRows(file.bytes, "Products");
      expect(rows[0], "the file's columns").toEqual([...SETUP_HEADERS]);
      const wb = await loadWorkbook(file.bytes);
      expect(wb.getWorksheet("Instructions"), "an Instructions sheet").toBeTruthy();
      const ours = rows.slice(1).filter((r) => codes.has(r[COL.id].toUpperCase()));
      expect(ours.length, "the 5 throw-away listings are in the file").toBe(5);
      const edited = ours.map((r, i) => {
        const cells = asCells(r);
        const item = codes.get(r[COL.id].toUpperCase())!;
        if (i < 3) {
          cells[COL.price] = (item.mrpPaise - 100) / 100;
          cells[COL.stock] = 7 + i;
        }
        if (i === 3) cells[COL.include] = "No";
        return cells;
      });
      const unknown = `QA-NOPE-${RUN}`.toUpperCase();
      edited.push([unknown, null, "Not a product", null, null, null, null, "Yes", null, 10, 5]);
      const bytes = await workbook(rows[0], edited, name);
      await page.getByLabel("Choose your file").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: bytes });
      const preview = page.getByTestId("upload-preview");
      await expect(preview).toBeVisible({ timeout: 180_000 });
      const uploadId = await latestUploadNamed(owner, shop.id, name);
      const view = await settledUpload(owner, shop.id, uploadId);
      expect({ update: view.counts.update, pause: view.counts.pause, errors: view.counts.errors, unchanged: view.counts.unchanged }).toEqual({ update: 3, pause: 1, errors: 1, unchanged: 1 });
      await expect(preview.getByTestId("upload-errors")).toContainText(`Product ID ${unknown} is not in the GoKesari product list. Add it as a new product instead.`);
      await preview.getByLabel(/Yes, pause 1 product marked No/).check();
      await preview.getByRole("button", { name: "Import valid rows and skip errors" }).click();
      await expect(page.getByTestId("setup-result")).toBeVisible({ timeout: 180_000 });
      const done = await settledUpload(owner, shop.id, uploadId);
      expect(done.status).toBe("DONE");
      stash(SAME_FILE, { name, path: join(FILE_DIR, name), at: Date.now(), run: RUN_KEY });
    } finally {
      await context.close();
    }
    const after = await setupListings(owner, shop.id);
    const out: string[] = [];
    const byCode = new Map([...codes.values()].map((i) => [i.code.toUpperCase(), need(after.find((l) => l.id === i.shopProductId), `listing ${i.name}`)]));
    for (const [code, l] of byCode) out.push(`${code} ${statusOf(l)} ₹${(l.onlinePricePaise ?? 0) / 100} × ${Number(l.onlineStock)}`);
    const changed = [...byCode.values()].filter((l) => [7, 8, 9].includes(Number(l.onlineStock)));
    expect(changed.length, `three rows changed: ${out.join("; ")}`).toBe(3);
    for (const l of changed) expect(l.onlinePricePaise, "₹1 below the MRP").toBe((l.product.mrpPaise ?? 0) - 100);
    const paused = [...byCode.values()].filter((l) => l.ownerPaused);
    expect(paused.length, "the Include = No product is paused, not removed").toBe(1);
    expect(statusOf(paused[0])).toBe("PAUSED");
    return out.join("; ");
  });
}, signed);

qa("TC-CAT-085", "the same setup file uploaded again the same day: 'This exact file was already imported today, so it was not applied again.'", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const kept = unstash<{ name: string; path: string; at: number; run: string }>(SAME_FILE);
  if (!kept || kept.run !== RUN_KEY) blocked("needs the setup file TC-CAT-082 imported in this run");
  if (Date.now() - kept.at > 23 * 3_600_000) blocked("the file of TC-CAT-082 was imported more than 23 hours ago");
  const bytes = readFileSync(kept.path);
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  try {
    await page.goto("/shop/my-products");
    await page.getByText("Update many products with Excel", { exact: true }).click();
    await page.getByLabel("Choose your file").setInputFiles({ name: kept.name, mimeType: XLSX_TYPE, buffer: bytes });
    await expect(page.getByText("This exact file was already imported today, so it was not applied again.", { exact: true })).toBeVisible({ timeout: 60_000 });
  } finally {
    await context.close();
  }
  const api = await uploadSetupFile(owner, shop.id, kept.name, bytes);
  if (api.status === 202) {
    await settledUpload(owner, shop.id, api.body.uploadId).catch(() => undefined);
    await cancelSetupUpload(owner, shop.id, api.body.uploadId);
  }
  expect(api.status, why(api)).toBe(409);
  expect(api.body?.error?.message).toBe("This exact file was already imported today, so it was not applied again.");
  const history = await call(owner, "GET", `/api/shops/${shop.id}/product-setup/uploads`);
  expect(((history.body.uploads ?? []) as { fileName: string }[]).filter((u) => u.fileName === kept.name).length, "no second upload stored").toBe(1);
  return `page and API (409): "${api.body?.error?.message}"`;
}, signed);

qa(["TC-CAT-083"], "every rejected setup row says why: Product ID missing / twice / unknown (with the 'Add new product' link, D-1), Include = Maybe, Selling 'ten', Shop MRP 0", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const mine = await myProductsFile(owner, shop.id);
  const codes = mine.slice(1).map((r) => r[COL.id].toUpperCase()).filter(Boolean);
  if (codes.length < 4) blocked("shop A needs at least 4 listings for the known Product IDs");
  const [dup, c2, c3, c4] = codes;
  const unknown = `QA-NOPE-${RUN}`.toUpperCase();
  const blank = (code: string | null, include: string | null, shopMrp: string | number | null, price: string | number | null, stock: number | null) =>
    [code, null, code ? null : "No product id", null, null, null, null, include, shopMrp, price, stock];
  const name = `qa-setup-errors-${RUN}.xlsx`;
  const bytes = await workbook(SETUP_HEADERS, [
    blank(null, "Yes", null, 10, 5),
    blank(dup, "Yes", null, null, null),
    blank(dup, "Yes", null, null, null),
    blank(unknown, "Yes", null, 10, 5),
    blank(c2, "Maybe", null, null, null),
    blank(c3, "Yes", null, "ten", null),
    blank(c4, "Yes", 0, null, null),
  ], name);
  const expected = [
    "Row 2: Product ID is missing.",
    `Row 3: Product ID ${dup} appears more than once in this file. Keep one row.`,
    `Row 4: Product ID ${dup} appears more than once in this file. Keep one row.`,
    `Row 5: Product ID ${unknown} is not in the GoKesari product list. Add it as a new product instead.`,
    "Row 6: Include must be Yes or No.",
    "Row 7: Selling Price must be a number.",
    "Row 8: Shop MRP must be more than 0.",
  ];
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  let uploadId = "";
  try {
    await page.goto("/shop/my-products");
    await page.getByText("Update many products with Excel", { exact: true }).click();
    await page.getByLabel("Choose your file").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: bytes });
    const preview = page.getByTestId("upload-preview");
    await expect(preview).toBeVisible({ timeout: 180_000 });
    uploadId = await latestUploadNamed(owner, shop.id, name);
    const list = preview.getByTestId("upload-errors");
    for (const m of expected) await expect(list).toContainText(m);
    const link = list.getByTestId("add-new-product-link");
    await expect(link, "one 'Add new product' link, next to the unknown Product ID").toHaveCount(1);
    await expect(link).toHaveText("Add new product");
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/shop\/manage\/products(\?shop=[0-9a-f-]{36})?#products$/);
    await expect(preview.getByRole("button", { name: /^Import/ })).toBeDisabled();

    const file = await downloadFrom(page, preview.getByRole("link", { name: "Download error file" }));
    const wb = await loadWorkbook(file.bytes);
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => cellText(v));
    expect(header).toEqual([...SETUP_HEADERS, "Error", "Add new product"]);
    expect(ws.actualRowCount - 1, "one row per rejected row").toBe(7);
    let linked = "";
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const v = row.getCell(header.length).value as { hyperlink?: string } | null;
      if (v && typeof v === "object" && v.hyperlink) linked = `${cellText(row.getCell(1).value)} → ${v.hyperlink}`;
    });
    expect(linked, "the error file links the unknown Product ID to the add-new-product form").toMatch(new RegExp(`^${unknown} → https?://.+/shop/manage/products.*#products$`));
    await preview.getByRole("button", { name: "Cancel" }).click();
    return `${expected.join(" | ")}; link ${href}; error file ${file.name}: ${linked}`;
  } finally {
    await context.close();
    if (uploadId) await cancelSetupUpload(owner, shop.id, uploadId);
  }
}, { ...signed, partial: "'Add the category \"X\" to your shop first.' needs a product in a category shop A does not carry: the local check" });

qa("TC-CAT-084", "setup file limits: 5,000 rows are checked, 5,001 rows are refused ('This file has too many rows. The limit is 5,000 products per file.'), nothing applied", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  const ids: string[] = [];
  try {
    await page.goto("/shop/my-products");
    await page.getByText("Update many products with Excel", { exact: true }).click();
    const text = await page.getByText(/^Excel \(\.xlsx\) or CSV, up to [\d,]+ products and \d+ MB\./).innerText();
    const [, rowsText, mb] = need(text.match(/up to ([\d,]+) products and (\d+) MB/), "the limits line");
    if (rowsText !== "5,000" || mb !== "10") blocked(`the productImport rule on this site is ${rowsText} rows / ${mb} MB, not the default 5,000 / 10 MB`);
    const many = (n: number) => Array.from({ length: n }, (_, i) => [`QA-LIM-${RUN}-${i}`.toUpperCase(), null, null, null, null, null, null, "Yes", null, 10, 1]);
    const over = `qa-setup-5001-${RUN}.xlsx`;
    await page.getByLabel("Choose your file").setInputFiles({ name: over, mimeType: XLSX_TYPE, buffer: await workbook(SETUP_HEADERS, many(5001), over) });
    await expect(page.getByText("This file has too many rows. The limit is 5,000 products per file.", { exact: true })).toBeVisible({ timeout: 180_000 });
    const rejected = await settledUpload(owner, shop.id, await latestUploadNamed(owner, shop.id, over));
    expect(rejected.status).toBe("REJECTED");

    const exact = `qa-setup-5000-${RUN}.xlsx`;
    const up = await uploadSetupFile(owner, shop.id, exact, await workbook(SETUP_HEADERS, many(5000), exact));
    expectStatus(up, 202, "upload 5,000 rows");
    ids.push(up.body.uploadId);
    const checked = await settledUpload(owner, shop.id, up.body.uploadId, 300_000);
    expect(checked.status, checked.failure ?? "").toBe("READY");
    expect(checked.counts.totalRows).toBe(5000);
    return `5,001 rows → REJECTED "${rejected.failure}"; 5,000 rows → READY (${checked.counts.errors} unknown Product IDs listed), cancelled`;
  } finally {
    await context.close();
    for (const id of ids) await cancelSetupUpload(owner, shop.id, id);
  }
}, { ...signed, timeout: 600_000, partial: "the 11 MB file is the local check (an 11 MB upload is not sent to the test site)" });

/* -------------------------------------------- starter shelf and barcodes */

qa("TC-CAT-086", "starter shelf API for shop A: on, up to 100 products of its categories it does not list, with the MRP and a default stock of 100", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const res = await call(owner, "GET", `/api/shops/${shop.id}/starter-shelf`);
  expectStatus(res, 200, "GET starter shelf");
  if (!res.body.enabled) blocked("rule starterShelf is off on this site");
  const items = res.body.items as { productId: string; kind: string; mrpPaise: number | null; name: string }[];
  expect(res.body.defaultStock, "stock 100").toBe(100);
  expect(items.length, "at most 100").toBeLessThanOrEqual(100);
  const listed = new Set((await setupListings(owner, shop.id)).map((l) => l.productId));
  expect(items.filter((i) => listed.has(i.productId)).map((i) => i.name), "nothing shop A already lists").toEqual([]);
  const withMrp = items.filter((i) => i.mrpPaise != null).length;
  return `${items.length} products offered (${withMrp} with an MRP, which the page pre-ticks at that price), default stock ${res.body.defaultStock}, none already listed`;
}, { ...signed, partial: "the page (pre-ticked at MRP, the 90-day order ranking, publishing N Live listings) is the local check: the shelf is step 7 of a new shop's registration" });

qa("TC-CAT-087", "starter shelf publish refuses an empty list ('Tick at least one product.') and a ticked product without a price", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const before = (await setupListings(owner, shop.id)).length;
  const none = await call(owner, "POST", `/api/shops/${shop.id}/starter-shelf`, { items: [] });
  expect(none.status, why(none)).toBe(422);
  expect(JSON.stringify(none.body)).toContain("Tick at least one product.");
  const shelf = await call(owner, "GET", `/api/shops/${shop.id}/starter-shelf`);
  const productId = (shelf.body?.items?.[0]?.productId as string | undefined) ?? world().listings.packaged?.productId ?? "00000000-0000-4000-8000-000000000000";
  const free = await call(owner, "POST", `/api/shops/${shop.id}/starter-shelf`, { items: [{ productId, pricePaise: 0, stock: 100 }] });
  expect(free.status, why(free)).toBe(422);
  expect(JSON.stringify(free.body)).toContain("Every ticked product needs a price.");
  expect((await setupListings(owner, shop.id)).length, "nothing listed").toBe(before);
  return `empty → 422 "Tick at least one product."; price 0 → 422 "Every ticked product needs a price."`;
}, { ...signed, partial: "the page's own messages (Publish disabled with nothing ticked; 'Enter a price for X, or untick it.') are the local check" });

qa("TC-CAT-088", "barcode look-up of a pack shop A sells: the product with its MRP, marked already in the shop", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const coded = (await setupListings(owner, shop.id)).find((l) => (l.product.gtin ?? l.product.barcode ?? "").replace(/\W/g, "").length >= 6);
  if (!coded) blocked("no product shop A sells has a barcode on this site");
  const code = (coded.product.gtin ?? coded.product.barcode)!;
  const res = await call(owner, "GET", `/api/shops/${shop.id}/barcode-lookup?code=${encodeURIComponent(code)}`);
  expectStatus(res, 200, "barcode look-up");
  expect(res.body.match, "the pack is found").toMatchObject({ name: coded.product.name, mrpPaise: coded.product.mrpPaise, listed: true });
  return `${code} → ${res.body.match.name}, MRP ₹${(res.body.match.mrpPaise ?? 0) / 100}, already in the shop`;
}, { ...signed, partial: "'Added X at MRP ₹…' for a pack the shop does not sell, and the listing after publishing, are the local check (typed code; the camera itself is manual)" });

qa("TC-CAT-089", "barcode look-up: a code shorter than 6 digits is refused ('Enter the barcode number (at least 6 digits).'); an unknown code finds nothing", async () => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const short = await call(owner, "GET", `/api/shops/${shop.id}/barcode-lookup?code=12345`);
  expect(short.status, why(short)).toBe(422);
  expect(short.body?.error?.message).toBe("Enter the barcode number (at least 6 digits).");
  const code = `99${String(Date.now()).slice(-11)}`;
  const unknown = await call(owner, "GET", `/api/shops/${shop.id}/barcode-lookup?code=${code}`);
  expectStatus(unknown, 200, "unknown code");
  expect(unknown.body).toEqual({ code, match: null });
  return `12345 → 422; ${code} → no match`;
}, { ...signed, partial: "the page ('<code> is not in our catalogue yet…', 'Sent to our team…', the admin's approval queue) is the local check: sending it would add a catalogue product on the test site" });

/* ----------------------------------------------------- how you deliver */

const CHOICE_LABEL: Record<string, string> = { OWN_STAFF: "My own delivery staff", GOKESARI_PARTNER: "GoKesari delivery partners", PICKUP_ONLY: "Pickup only" };

qa("TC-CAT-090", "How do you deliver?: the three choices; radius 3 km saved ('Saved. Customers now see how you deliver.'); a customer 4 km away cannot get delivery, one 2 km away can", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const before = await ownerView(owner, shop.id);
  if (!before.deliveryAvailable || before.deliveryChoice === "PICKUP_ONLY") blocked("shop A does not deliver on this site");
  const choice = before.deliveryChoice ?? "GOKESARI_PARTNER";
  const item = need(world().listings.packaged, "shop A's packaged listing");
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  try {
    await page.goto("/shop/setup/delivery");
    await expect(page.getByRole("heading", { name: "How do you deliver?" })).toBeVisible();
    for (const label of Object.values(CHOICE_LABEL)) await expect(page.getByRole("radio", { name: new RegExp(label) })).toBeVisible();
    await page.getByRole("radio", { name: new RegExp(CHOICE_LABEL[choice]) }).check();
    const slider = page.getByTestId("delivery-radius");
    await slider.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Deliver up to (km from your shop): 3 km")).toBeVisible();
    await page.getByTestId("delivery-save").click();
    await expect(page.getByRole("status").filter({ hasText: "Saved. Customers now see how you deliver." }).first()).toBeVisible();
    const saved = await ownerView(owner, shop.id);
    expect({ radius: saved.serviceRadiusKm, delivers: saved.deliveryAvailable, choice: saved.deliveryChoice }).toEqual({ radius: 3, delivers: true, choice });
    const checks = await withAddresses("customer", [
      { ...pointNorth(2), line1: `QA 2 km ${RUN}`, label: `QA 2 km ${RUN}` },
      { ...pointNorth(4), line1: `QA 4 km ${RUN}`, label: `QA 4 km ${RUN}` },
    ], async ([near, far]) => {
      await fillCart("customer", [{ item, quantity: 1 }]);
      const a = need((await validateCart("customer", near.id)).shops.find((s) => s.shopId === shop.id), "shop A in the cart check");
      const b = need((await validateCart("customer", far.id)).shops.find((s) => s.shopId === shop.id), "shop A in the cart check");
      return { a, b };
    });
    expect(checks.a.issues.map((i) => i.code), "2 km away: delivered").not.toContain("NOT_DELIVERABLE");
    const far = checks.b.issues.find((i) => i.code === "NOT_DELIVERABLE");
    expect(far?.message, "4 km away: no delivery").toMatch(/does not deliver/);
    return `"${CHOICE_LABEL[choice]}", 3 km saved; 2 km: delivered; 4 km: "${far?.message}"${before.deliveryChoice ? "" : " (shop A had no choice saved before; delivery stays on)"}`;
  } finally {
    await context.close();
    await clearCart("customer").catch(() => undefined);
    const back = await call(owner, "PATCH", `/api/shops/${shop.id}`, { serviceRadiusKm: before.serviceRadiusKm });
    expectStatus(back, 200, "restore shop A's radius");
  }
}, signed);

qa("TC-CAT-091", "the radius slider stops at 1 and 10 km; choosing Pickup only hides it", async ({ browser }) => {
  const { context, page } = await pageAs(browser, "shop", { viewport: DESKTOP });
  try {
    await page.goto("/shop/setup/delivery");
    await page.getByRole("radio", { name: /My own delivery staff/ }).check();
    const slider = page.getByTestId("delivery-radius");
    await expect(slider).toHaveAttribute("min", "1");
    await expect(slider).toHaveAttribute("max", "10");
    await slider.focus();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Deliver up to (km from your shop): 10 km")).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("Deliver up to (km from your shop): 1 km")).toBeVisible();
    await page.getByRole("radio", { name: /Pickup only/ }).check();
    await expect(slider).toHaveCount(0);
  } finally {
    await context.close();
  }
  return "slider 1–10 km (End/→ stop at 10, Home/← at 1); Pickup only: no radius; nothing saved";
}, { ...signed, partial: "saving Pickup only and the customer's checkout without delivery are the local check (on a fresh shop)" });

/* ---------------------------------------------------------- shop logo */

qa("TC-CAT-092", "shop logo address: javascript:, data: and http: are refused (422); an https address (or the site's own /api/images/<id>) is saved and shown on the shop's card", async ({ browser }) => {
  const shop = await shopOf("A");
  const owner = await as("shop");
  const before = await ownerView(owner, shop.id);
  const refusals: string[] = [];
  const https = `https://example.com/qa-logo-${RUN}.png`;
  try {
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,iVBORw0KGgo=", "http://example.com/logo.png"]) {
      const res = await call(owner, "PATCH", `/api/shops/${shop.id}`, { logoUrl: bad });
      expect(res.status, `${bad}: ${why(res)}`).toBe(422);
      expect(res.body?.error?.details?.fields?.logoUrl, bad).toBe("Use an https:// image address or an uploaded image.");
      refusals.push(`${bad.slice(0, 11)} 422`);
    }
    expect((await ownerView(owner, shop.id)).logoUrl, "the logo is unchanged").toBe(before.logoUrl);
    const own = `/api/images/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
    expectStatus(await call(owner, "PATCH", `/api/shops/${shop.id}`, { logoUrl: own }), 200, "the site's own image path");
    expectStatus(await call(owner, "PATCH", `/api/shops/${shop.id}`, { logoUrl: https }), 200, "an https logo");
    expect((await ownerView(owner, shop.id)).logoUrl).toBe(https);
    const { context, page } = await pageAs(browser, "customer");
    try {
      await page.goto("/shops");
      const card = page.getByTestId("shop-card").filter({ hasText: shop.name }).first();
      await expect(card).toBeVisible();
      // The logo is decorative (alt=""), so it has no accessible role or name.
      await expect(card.locator("img").first()).toHaveAttribute("src", https);
    } finally {
      await context.close();
    }
    return `${refusals.join(", ")} ("Use an https:// image address or an uploaded image."); /api/images/<id> and ${https} saved; the https logo is on shop A's card in /shops`;
  } finally {
    const back = await call(owner, "PATCH", `/api/shops/${shop.id}`, { logoUrl: before.logoUrl });
    expectStatus(back, 200, "restore shop A's logo");
  }
}, { ...signed, partial: "there is no logo field on the owner's settings pages: the address is set through PATCH /api/shops/<id> (a logo file upload is planned, D-144)" });
