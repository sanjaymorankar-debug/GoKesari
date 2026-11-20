/**
 * Helpers for "Set up your shop's products" (docs/shop-product-setup-2026-11), the
 * bulk product upload (docs/product-import-2026-10), the starter shelf, barcode
 * look-up and "How you deliver" checks (group C, 20-Nov-2026).
 *
 * - listing statuses computed from the owner's API exactly as src/lib/listing-status.ts does;
 * - throw-away listings on a shop: products of its categories that it does not
 *   list yet, picked through the setup API and removed again afterwards, so the
 *   world's listings (milk, premium, lowStock, packaged, sharedA…) are never touched;
 * - the setup Excel ("Update many products with Excel") and the product import
 *   template: workbooks made at run time, uploads polled until checked;
 * - downloads through the page (attachment links) and the My products editor.
 *
 * Every writer refuses production (assertWritable).
 */
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";

import { db } from "./db";
import { call, expectStatus, RUN, stash, unstash, why, type Answer } from "./http";
import { blocked, expect, need } from "./record";
import { filePart, keep, newMasterProduct } from "./sellers-helpers";
import { assertWritable, IS_LOCAL } from "./target";
import { world } from "./world";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The setup file's columns (BULK_HEADERS in src/server/services/shop-bulk-upload.ts). */
export const SETUP_HEADERS = [
  "Product ID",
  "Category",
  "Product Name",
  "Brand",
  "Pack Size",
  "Unit",
  "Master MRP",
  "Include (Yes/No)",
  "Shop MRP",
  "Selling Price",
  "Stock Quantity",
] as const;
export const COL = { id: 0, category: 1, name: 2, masterMrp: 6, include: 7, shopMrp: 8, price: 9, stock: 10 } as const;

export type ListingStatus = "LIVE" | "NEEDS_STOCK" | "NEEDS_PRICE" | "OUT_OF_STOCK" | "PAUSED";
export const STATUSES: ListingStatus[] = ["LIVE", "NEEDS_STOCK", "NEEDS_PRICE", "OUT_OF_STOCK", "PAUSED"];
export const STATUS_LABEL: Record<ListingStatus, string> = {
  LIVE: "Live",
  NEEDS_STOCK: "Needs Stock",
  NEEDS_PRICE: "Needs Price",
  OUT_OF_STOCK: "Out of Stock",
  PAUSED: "Paused",
};

export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 900 };

/* ------------------------------------------------------------ listings */

/** A listing as the owner's GET /api/shops/:id/products returns it (every shop_products column). */
export interface SetupListing {
  id: string;
  shopId: string;
  productId: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  onlineStock: number | string;
  offlineStock: number | string;
  isActive: boolean;
  isAvailable: boolean;
  ownerPaused?: boolean;
  stockPending?: boolean;
  trackInventory?: boolean;
  categoryCarried?: boolean;
  deletedAt?: string | null;
  product: { id: string; code: string; name: string; kind: string; mrpPaise: number | null; categoryId: string; unit: string; gtin?: string | null; barcode?: string | null; approvalStatus?: string };
}

export async function setupListings(ctx: APIRequestContext, shopId: string): Promise<SetupListing[]> {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/products`);
  expectStatus(res, 200, "the owner's listings");
  return (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as SetupListing[];
}

/** src/lib/listing-status.ts `listingStatus`, applied to the owner's API row. */
export function statusOf(l: SetupListing): ListingStatus {
  const online = Number(l.onlineStock);
  const offline = Number(l.offlineStock);
  const track = l.trackInventory !== false;
  if (!l.isActive || l.ownerPaused || l.categoryCarried === false) return "PAUSED";
  if (l.stockPending && track && online <= 0 && offline <= 0) return "NEEDS_STOCK";
  if (l.onlinePricePaise == null && l.offlinePricePaise == null) return "NEEDS_PRICE";
  if (!l.onlineSaleEnabled && !l.offlineSaleEnabled) return "PAUSED";
  const stock = l.onlineSaleEnabled ? online : offline;
  if (track && stock <= 0) return "OUT_OF_STOCK";
  if (l.onlineSaleEnabled && !l.isAvailable) return "PAUSED";
  return "LIVE";
}

const setupBase = (shopId: string) => `/api/shops/${shopId}/product-setup`;

/** Step 3 / My products: save prices and quantities ("live" applies both). */
export async function saveListings(ctx: APIRequestContext, shopId: string, rows: { shopProductId: string; pricePaise?: number | null; stock?: number | null; shopMrpPaise?: number | null }[], action: "live" | "skip" = "live"): Promise<Answer> {
  assertWritable("save listing figures");
  return call(ctx, "POST", `${setupBase(shopId)}/listings`, { action, rows });
}

export async function pauseListing(ctx: APIRequestContext, shopId: string, shopProductId: string, paused: boolean): Promise<Answer> {
  assertWritable("pause a listing");
  return call(ctx, "PATCH", `${setupBase(shopId)}/listings`, { shopProductId, paused });
}

export interface PickerProduct {
  id: string;
  code: string;
  name: string;
  kind: string;
  mrpPaise: number | null;
  categoryId: string;
  categoryName: string;
  alreadyAdded: boolean;
}

/** Products of the shop's categories it does not list yet (packaged, with an MRP of at least ₹3). */
export async function pickableProducts(ctx: APIRequestContext, shopId: string, n: number, filters: { q?: string; category?: string } = {}): Promise<PickerProduct[]> {
  const out: PickerProduct[] = [];
  for (let offset = 0, page = 0; page < 12 && out.length < n; page++, offset += 50) {
    const query = new URLSearchParams({ offset: String(offset), ...(filters.q ? { q: filters.q } : {}), ...(filters.category ? { category: filters.category } : {}) });
    const res = await call(ctx, "GET", `${setupBase(shopId)}/products?${query.toString()}`);
    expectStatus(res, 200, "the setup picker's products");
    const rows = (res.body.products ?? []) as PickerProduct[];
    out.push(...rows.filter((p) => !p.alreadyAdded && p.kind === "PACKAGED" && (p.mrpPaise ?? 0) >= 300));
    if (offset + rows.length >= Number(res.body.total ?? 0) || rows.length === 0) break;
  }
  return out.slice(0, n);
}

export interface ThrowAway {
  shopProductId: string;
  productId: string;
  code: string;
  name: string;
  mrpPaise: number;
  categoryId: string;
  categoryName: string;
}

const LEFTOVERS = (shopId: string) => `product-setup-throwaway-${shopId}`;

/** Zero the stock (so a later pick waits as Needs Stock again) and remove the listing. */
async function removeThrowAway(ctx: APIRequestContext, shopId: string, shopProductId: string) {
  await saveListings(ctx, shopId, [{ shopProductId, stock: 0 }]).catch(() => undefined);
  const res = await call(ctx, "DELETE", `/api/shop-products/${shopProductId}`);
  if (![200, 404].includes(res.status)) console.error(`[product-setup] could not remove throw-away listing ${shopProductId}: ${why(res)}`);
}

/** Listings a crashed earlier run left behind (kept in the stash) are removed first. */
async function removeLeftovers(ctx: APIRequestContext, shopId: string) {
  const left = unstash<{ ids: string[]; categories: string[] }>(LEFTOVERS(shopId));
  if (!left) return;
  for (const id of left.ids) await removeThrowAway(ctx, shopId, id);
  for (const c of left.categories) await call(ctx, "DELETE", `/api/shops/${shopId}/product-categories/${c}`);
  stash(LEFTOVERS(shopId), null);
}

/**
 * Runs `fn` with `n` new listings of `shopId` (each waiting as Needs Stock, priced at its MRP),
 * made from products of the shop's categories it did not list, and removes them afterwards.
 * Locally, missing products are arranged in the world's QA category; on a deployed site a
 * category the shop does not carry may be added for the check and removed again.
 */
export async function withThrowAway<T>(ctx: APIRequestContext, shopId: string, n: number, fn: (rows: ThrowAway[]) => Promise<T>): Promise<T> {
  assertWritable("add throw-away listings");
  await removeLeftovers(ctx, shopId);
  let picked = await pickableProducts(ctx, shopId, n);
  const addedCategories: string[] = [];
  if (picked.length < n && IS_LOCAL) {
    const category = need(world().category, "the world's QA category");
    for (let i = picked.length; i < n; i++) await newMasterProduct({ name: `QA Setup throw-away ${RUN} ${i}`, mrpPaise: 5000, categoryId: category.id });
    picked = await pickableProducts(ctx, shopId, n);
  }
  if (picked.length < n) {
    const all = await call(ctx, "GET", "/api/product-categories?selectable=1");
    const carried = await call(ctx, "GET", `/api/shops/${shopId}/product-categories`);
    const carriedIds = new Set(((carried.body?.categories ?? []) as { id?: string; categoryId?: string }[]).map((c) => c.categoryId ?? c.id));
    const candidates = ((all.body?.categories ?? []) as { id: string; isSystem: boolean }[]).filter((c) => !carriedIds.has(c.id) && !c.isSystem);
    for (const c of candidates.slice(0, 8)) {
      if (picked.length >= n) break;
      const add = await call(ctx, "POST", `/api/shops/${shopId}/product-categories`, { categoryId: c.id });
      if (add.status !== 201) continue;
      addedCategories.push(c.id);
      stash(LEFTOVERS(shopId), { ids: [], categories: addedCategories });
      const more = await pickableProducts(ctx, shopId, n - picked.length, { category: c.id });
      if (more.length === 0) {
        await call(ctx, "DELETE", `/api/shops/${shopId}/product-categories/${c.id}`);
        addedCategories.pop();
        continue;
      }
      picked.push(...more);
    }
  }
  const removeCategories = async () => {
    for (const c of addedCategories) await call(ctx, "DELETE", `/api/shops/${shopId}/product-categories/${c}`);
  };
  if (picked.length < n) {
    await removeCategories();
    stash(LEFTOVERS(shopId), null);
    blocked(`needs ${n} packaged products with a master MRP in this shop's categories that it does not list yet (found ${picked.length}; most of this site's master products have no MRP)`);
  }
  const add = await call(ctx, "POST", `${setupBase(shopId)}/products`, { productIds: picked.map((p) => p.id) });
  expectStatus(add, 200, "pick the throw-away products");
  const listings = await setupListings(ctx, shopId);
  const rows: ThrowAway[] = picked.map((p) => {
    const l = need(listings.find((x) => x.productId === p.id), `the new listing of ${p.name}`);
    return { shopProductId: l.id, productId: p.id, code: p.code, name: p.name, mrpPaise: p.mrpPaise ?? 0, categoryId: p.categoryId, categoryName: p.categoryName };
  });
  stash(LEFTOVERS(shopId), { ids: rows.map((r) => r.shopProductId), categories: addedCategories });
  try {
    return await fn(rows);
  } finally {
    for (const r of rows) await removeThrowAway(ctx, shopId, r.shopProductId);
    await removeCategories();
    stash(LEFTOVERS(shopId), null);
  }
}

/**
 * Puts five throw-away listings in the five states: Live (stock 5), Needs Stock (as picked),
 * Needs Price (stock 3, no price), Out of Stock (stock 0), Paused (stock 4, paused by the owner).
 */
export async function arrangeStates(ctx: APIRequestContext, shopId: string, rows: ThrowAway[]): Promise<Record<ListingStatus, ThrowAway>> {
  expect(rows.length, "five throw-away listings").toBeGreaterThanOrEqual(5);
  const before = await setupListings(ctx, shopId);
  const waiting = rows.find((r) => statusOf(need(before.find((l) => l.id === r.shopProductId), r.name)) === "NEEDS_STOCK");
  if (!waiting) blocked("none of the picked products came back as Needs Stock (an earlier listing of it kept its stock)");
  const rest = rows.filter((r) => r !== waiting);
  const by = { LIVE: rest[0], NEEDS_STOCK: waiting, NEEDS_PRICE: rest[1], OUT_OF_STOCK: rest[2], PAUSED: rest[3] } as Record<ListingStatus, ThrowAway>;
  expectStatus(
    await saveListings(ctx, shopId, [
      { shopProductId: by.LIVE.shopProductId, pricePaise: by.LIVE.mrpPaise, stock: 5 },
      { shopProductId: by.NEEDS_PRICE.shopProductId, stock: 3 },
      { shopProductId: by.OUT_OF_STOCK.shopProductId, pricePaise: by.OUT_OF_STOCK.mrpPaise, stock: 0 },
      { shopProductId: by.PAUSED.shopProductId, pricePaise: by.PAUSED.mrpPaise, stock: 4 },
    ]),
    200,
    "stock and price for the throw-away listings",
  );
  const unpriced = await call(ctx, "PATCH", `/api/shop-products/${by.NEEDS_PRICE.shopProductId}`, { onlineSaleEnabled: false, offlineSaleEnabled: false, onlinePricePaise: null, offlinePricePaise: null });
  expectStatus(unpriced, 200, "take the price off one listing");
  expectStatus(await pauseListing(ctx, shopId, by.PAUSED.shopProductId, true), 200, "pause one listing");
  const after = await setupListings(ctx, shopId);
  for (const s of STATUSES) {
    const l = need(after.find((x) => x.id === by[s].shopProductId), `listing ${by[s].name}`);
    expect(statusOf(l), `${by[s].name} arranged as ${s}`).toBe(s);
  }
  return by;
}

/* ---------------------------------------------------------- workbooks */

/** The text of an ExcelJS cell value (hyperlinks, rich text and formulas included). */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

export async function loadWorkbook(data: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  return wb;
}

/** A sheet's rows as cell texts (first row = header); `sheet` by name, else the first. */
export async function sheetRows(data: Buffer, sheet?: string): Promise<string[][]> {
  const wb = await loadWorkbook(data);
  const ws = need(sheet ? wb.getWorksheet(sheet) : wb.worksheets[0], `sheet ${sheet ?? "1"}`);
  const rows: string[][] = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let c = 1; c <= width; c++) values.push(cellText(row.getCell(c).value));
    rows.push(values);
  });
  return rows;
}

/** An .xlsx with one "Products" sheet: `header` then `rows`. */
export async function workbook(header: readonly string[], rows: (string | number | null)[][], name: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");
  ws.addRow([...header]);
  for (const r of rows) ws.addRow(r);
  return keep(name, Buffer.from(await wb.xlsx.writeBuffer()));
}

/** The product import's rows by column name (missing columns stay blank). */
export async function importWorkbook(columns: readonly string[], rows: Record<string, string | number | null>[], name: string): Promise<Buffer> {
  return workbook(columns, rows.map((r) => columns.map((c) => r[c] ?? null)), name);
}

/* ------------------------------------------------- setup Excel uploads */

export interface UploadView {
  id: string;
  fileName: string;
  status: "CHECKING" | "READY" | "REJECTED" | "APPLYING" | "DONE" | "CANCELLED" | "FAILED";
  failure: string | null;
  counts: { totalRows: number; goLive: number; needsStock: number; needsPrice: number; update: number; pause: number; outOfStock: number; errors: number; ignored: number; unchanged: number };
  errors: { row: number; message: string; code?: string }[];
  errorCount: number;
  result: Record<string, number> | null;
}

export async function uploadSetupFile(ctx: APIRequestContext, shopId: string, name: string, bytes: Buffer): Promise<Answer> {
  assertWritable("upload a setup file");
  return call(ctx, "POST", `${setupBase(shopId)}/uploads`, undefined, { multipart: { file: filePart(name, bytes, name.endsWith(".csv") ? "text/csv" : XLSX_TYPE) } });
}

/** Polls an upload until it is no longer being checked or applied. */
export async function settledUpload(ctx: APIRequestContext, shopId: string, uploadId: string, timeoutMs = 180_000): Promise<UploadView> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await call(ctx, "GET", `${setupBase(shopId)}/uploads/${uploadId}`);
    expectStatus(res, 200, "the upload");
    const view = res.body as UploadView;
    if (view.status !== "CHECKING" && view.status !== "APPLYING") return view;
    if (Date.now() > until) throw new Error(`upload ${uploadId} still ${view.status} after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** The newest upload of this file name (the page uploads it; the API shows what it became). */
export async function latestUploadNamed(ctx: APIRequestContext, shopId: string, fileName: string): Promise<string> {
  const res = await call(ctx, "GET", `${setupBase(shopId)}/uploads`);
  expectStatus(res, 200, "the upload history");
  const row = ((res.body.uploads ?? []) as { id: string; fileName: string }[]).find((u) => u.fileName === fileName);
  return need(row, `the upload ${fileName} in the history`).id;
}

export async function cancelSetupUpload(ctx: APIRequestContext, shopId: string, uploadId: string) {
  const res = await call(ctx, "POST", `${setupBase(shopId)}/uploads/${uploadId}/cancel`);
  if (![200, 409].includes(res.status)) console.error(`[product-setup] could not cancel upload ${uploadId}: ${why(res)}`);
}

/* --------------------------------------------- product import (PU) */

export const PU_COLUMNS = ["Product Name", "Category", "Brand", "MRP", "Selling Price", "Stock Qty", "Unit", "Loose Item (Y/N)", "GST %"] as const;

export interface ImportJob {
  id: string;
  status: string;
  fileName: string;
  counts: { totalRows: number; newProducts: number; updates: number; errors?: number; failed: number; created: number; updated: number; skipped: number };
  errorMessage?: string | null;
}

export interface ImportRow {
  rowNumber: number;
  status: string;
  messages: string[];
  plan: { outcome: string; name: string | null; mrpPaise: number | null; pricePaise: number | null } | null;
  listingId?: string | null;
  productId?: string | null;
}

export async function waitImportJob(ctx: APIRequestContext, jobId: string, done: (status: string) => boolean, timeoutMs = 180_000): Promise<ImportJob> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const res = await call(ctx, "GET", `/api/v1/product-imports/${jobId}`);
    expectStatus(res, 200, "the import job");
    const job = (res.body.job ?? res.body) as ImportJob;
    if (done(job.status)) return job;
    if (Date.now() > until) throw new Error(`import ${jobId} still ${job.status} after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 2_500));
  }
}

/** Uploads a product file and waits for its preview. */
export async function importPreview(ctx: APIRequestContext, shopId: string, name: string, bytes: Buffer): Promise<ImportJob> {
  assertWritable("upload a product file");
  const res = await call(ctx, "POST", `/api/v1/shops/${shopId}/product-imports`, undefined, { multipart: { file: filePart(name, bytes, XLSX_TYPE) } });
  expectStatus(res, 202, "upload the product file");
  const jobId = String(res.body.jobId ?? res.body.job?.id);
  return waitImportJob(ctx, jobId, (s) => s === "preview_ready" || s === "failed");
}

export async function importRows(ctx: APIRequestContext, jobId: string, status = "all"): Promise<ImportRow[]> {
  const res = await call(ctx, "GET", `/api/v1/product-imports/${jobId}/rows?status=${status}&page=1&pageSize=200`);
  expectStatus(res, 200, "the import rows");
  return res.body.rows as ImportRow[];
}

export async function latestImportNamed(ctx: APIRequestContext, shopId: string, fileName: string): Promise<string> {
  const res = await call(ctx, "GET", `/api/v1/shops/${shopId}/product-imports`);
  expectStatus(res, 200, "the import history");
  const list = (Array.isArray(res.body) ? res.body : (res.body.jobs ?? res.body.imports ?? res.body.history ?? [])) as { id: string; fileName: string }[];
  return need(list.find((j) => j.fileName === fileName), `the import ${fileName} in the history`).id;
}

export async function cancelImport(ctx: APIRequestContext, jobId: string) {
  const res = await call(ctx, "POST", `/api/v1/product-imports/${jobId}/cancel`);
  if (![200, 409].includes(res.status)) console.error(`[product-import] could not cancel ${jobId}: ${why(res)}`);
}

/** A category name the import knows: the first of the template's (hidden) Lists sheet. */
export async function knownCategory(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get("/api/v1/product-imports/template", { failOnStatusCode: false, timeout: 120_000 });
  expect(res.status(), "download the import template").toBe(200);
  const lists = await sheetRows(await res.body(), "Lists");
  const names = lists.slice(1).map((r) => r[0]).filter(Boolean);
  return need(names.find((n) => n !== "General") ?? names[0], "a category in the import template's list");
}

/* ------------------------------------------------------------- the page */

/** Clicks a download link on the page and returns the file's bytes and name. */
export async function downloadFrom(page: Page, link: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), link.click()]);
  const path = need(await dl.path(), "the downloaded file");
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
}

/** The My products / step 3 editor row of `name`, paging forward with "Next" until it shows. */
export async function stockRow(page: Page, name: string): Promise<Locator> {
  const rows = page.getByTestId("stock-row").filter({ hasText: name });
  for (let i = 0; i < 40; i++) {
    if (await rows.count()) return rows.first();
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (!(await next.count()) || !(await next.isEnabled())) break;
    await next.click();
  }
  await expect(rows.first(), `"${name}" in the stock and price editor`).toBeVisible();
  return rows.first();
}

/* ------------------------------------------------- starter shelf (local) */

/**
 * The registration wizard of `shopId` for its owner (local only): the step a shop registered
 * through the wizard is in once it is live — "🎉 … is live", then step 7 "Add your products"
 * (the starter shelf). A shop made through POST /api/shops has no wizard draft, so one is
 * arranged as the wizard leaves it after payment (status SUBMITTED, linked to the shop).
 */
export async function arrangeWizardDraft(ownerId: string, shopId: string) {
  if (!IS_LOCAL) blocked("arranges a registration draft in the local database (local run only)");
  await db()`insert into shop_registration_drafts (owner_id, shop_id, status) values (${ownerId}, ${shopId}, 'SUBMITTED')`;
}

/** Opens the starter shelf from the live step of the registration (the page must be signed in as the owner). */
export async function openStarterShelf(page: Page): Promise<Locator> {
  await page.goto("/shop/register");
  await page.getByTestId("add-products").click();
  await expect(page.getByText("7. Add your products")).toBeVisible();
  const shelf = page.getByTestId("starter-shelf");
  await expect(shelf).toBeVisible({ timeout: 60_000 });
  return shelf;
}

/** Product ordering signals the shelf ranks by (local only): orders in 90 days, then shops stocking it. */
export async function shelfSignals(productIds: string[]) {
  if (!productIds.length) return new Map<string, { ordered: number; stocked: number }>();
  const rows = await db()<{ product_id: string; ordered: number; stocked: number }[]>`
    select p.id as product_id,
      (select count(distinct oi.order_id)::int from order_items oi join shop_products osp on osp.id = oi.shop_product_id
         join orders o on o.id = oi.order_id
        where osp.product_id = p.id and o.created_at >= now() - interval '90 days'
          and o.status::text in ('CONFIRMED','ACCEPTED','PREPARING','READY','ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED')) as ordered,
      (select count(*)::int from shop_products sp where sp.product_id = p.id and sp.deleted_at is null) as stocked
    from products p where p.id = any(${productIds})`;
  return new Map(rows.map((r) => [r.product_id, { ordered: Number(r.ordered), stocked: Number(r.stocked) }]));
}

/** A new product category (local only), department DAIRY. */
export async function newCategory(label: string): Promise<{ id: string; name: string }> {
  if (!IS_LOCAL) blocked("arranges a product category in the local database (local run only)");
  const name = `QA ${label} ${RUN}`;
  const [row] = await db()<{ id: string }[]>`
    insert into product_categories (department, name, slug) values ('DAIRY', ${name}, ${`${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`}) returning id`;
  return { id: row.id, name };
}

/** A master product with a barcode (local only): what a pack's code finds. */
export async function productWithBarcode(categoryId: string, mrpPaise = 4500) {
  const product = await newMasterProduct({ name: `QA Scanned ${RUN} ${Date.now().toString(36)}`, mrpPaise, categoryId });
  const code = `77${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 10)}`;
  await db()`update products set barcode = ${code} where id = ${product.id}`;
  return { ...product, barcode: code, mrpPaise };
}
