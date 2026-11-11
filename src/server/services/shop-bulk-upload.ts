/**
 * The Excel / CSV side of "Set up your shop's products"
 * (docs/shop-product-setup-2026-11). A file is read and checked in the
 * background, shown to the owner as a preview, and applied only after they
 * confirm. Rows match on Product ID alone: the read-only columns can never
 * change the master.
 */
import { createHash } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import ExcelJS from "exceljs";

import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { rupeesToPaise } from "@/lib/money";
import type { ProductKind } from "@/lib/stock-quantity";
import { roundStock } from "@/lib/stock-quantity";
import { db } from "@/server/db";
import { checkCommissionMilestonesSafely } from "@/server/dealers/commission";
import {
  brands,
  productCategories,
  products,
  shopBulkUploads,
  shopListingDetails,
  shopProducts,
  shops,
  users,
  type ShopBulkUpload,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { readSpreadsheet, type CellValue } from "@/server/product-import/grid";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { updateShopProduct } from "./catalogue";
import { sanitiseCell } from "./excel";
import { notify } from "./notifications";
import { getImportLimits } from "./product-import";
import { assertCanManageShopCategories, shopCarriesProductCategory } from "./product-categories";
import { listingValueProblem, listShopListings, packSizeLabel, saveSetupStep, setListingPaused, setShopMrp, type SetupActor } from "./shop-product-setup";

export const BULK_HEADERS = [
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
const READ_ONLY_COLUMNS = 7;
const SHEET_NAME = "Products";
const COL = { id: 0, include: 7, shopMrp: 8, price: 9, stock: 10 };

/** The same file cannot be applied twice within this long. */
const REPEAT_WINDOW_MS = 24 * 60 * 60_000;
/** No progress for this long: the server restarted, so the work is picked up again. */
const STALLED_MS = 5 * 60_000;
const APPLY_BATCH = 200;

export interface BulkDownload {
  bytes: Buffer;
  fileName: string;
  contentType: string;
}

type TemplateRow = (string | number | null)[];

const rupees = (paise: number | null | undefined) => (paise == null ? null : paise / 100);
const safeName = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "shop";

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : typeof value === "number" ? String(value) : sanitiseCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: readonly string[], rows: TemplateRow[]): Buffer {
  const lines = [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

const INSTRUCTIONS: string[] = [
  "How to use this file",
  "",
  "1. Open the Products sheet. Do not change the grey columns.",
  "2. In Include, write Yes for each product you want to sell. Write No to stop selling a product you already have.",
  "3. Selling Price is the price customers pay. Leave it blank if you are not sure; the product will wait as Needs Price.",
  "4. Stock Quantity is how many you have. Leave it blank if you are not sure; the product will wait as Needs Stock.",
  "5. Shop MRP is only for when the MRP on your pack is different. It changes the MRP for your shop only.",
  "6. Save the file and upload it. You will see what will happen before anything is saved.",
  "",
  "Good to know",
  "- For products already in your shop, a blank cell means no change. Only a typed 0 sets stock to 0.",
  "- Stock must be a whole number. Loose goods (sold by weight) can have decimals, such as 2.5.",
  "- Do not change the Product ID. It is how we find the product.",
  "",
  "Example",
  "Product ID: P00123  |  Include: Yes  |  Selling Price: 45  |  Stock Quantity: 20",
  "This puts the product on sale at ₹45 with 20 in stock.",
];

async function toWorkbook(headers: readonly string[], rows: TemplateRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = headers.map((h, i) => ({ header: h, width: i === 2 ? 40 : i === 1 ? 22 : i === headers.length - 1 && h === "Error" ? 50 : 16 }));
  sheet.getColumn(1).numFmt = "@";
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) {
    const added = sheet.addRow(row.map((v) => (typeof v === "string" ? sanitiseCell(v) : v)));
    added.getCell(1).numFmt = "@";
    added.eachCell({ includeEmpty: true }, (cell, column) => {
      if (column <= READ_ONLY_COLUMNS) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
      } else {
        cell.protection = { locked: false };
      }
    });
    added.getCell(COL.include + 1).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No"'] };
    for (let c = COL.include + 1; c <= BULK_HEADERS.length; c += 1) added.getCell(c).protection = { locked: false };
  }
  await sheet.protect("", { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, autoFilter: true, sort: true });
  const help = workbook.addWorksheet("Instructions");
  help.getColumn(1).width = 110;
  for (const line of INSTRUCTIONS) help.addRow([line]);
  help.getRow(1).font = { bold: true, size: 14 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function download(base: string, format: "xlsx" | "csv", headers: readonly string[], rows: TemplateRow[]): Promise<BulkDownload> {
  if (format === "csv") return { bytes: toCsv(headers, rows), fileName: `${base}.csv`, contentType: "text/csv; charset=utf-8" };
  return {
    bytes: await toWorkbook(headers, rows),
    fileName: `${base}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

/** Master products of the shop's chosen categories, ready to fill in. */
export async function buildTemplate(shopId: string, format: "xlsx" | "csv", actor: SetupActor): Promise<BulkDownload> {
  const shop = await assertCanManageShopCategories(shopId, actor);
  const rows = await db
    .select({
      code: products.code,
      category: productCategories.name,
      name: products.name,
      brand: brands.name,
      netQuantity: products.netQuantity,
      netQuantityUnit: products.netQuantityUnit,
      unit: products.unit,
      unitSizeMilli: products.unitSizeMilli,
      kind: products.kind,
      mrpPaise: products.mrpPaise,
    })
    .from(products)
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(
      and(
        isNull(products.deletedAt),
        eq(products.isActive, true),
        eq(products.approvalStatus, "APPROVED"),
        shopCarriesProductCategory(shopId, products.categoryId),
      ),
    )
    .orderBy(productCategories.name, products.name);
  const carried = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(productCategories)
    .where(shopCarriesProductCategory(shopId, productCategories.id));
  if (!carried[0]?.n) throw validationFailed("Choose at least one category first, then download the template.");
  return download(
    `gokesari-products-${safeName(shop.name)}`,
    format,
    BULK_HEADERS,
    rows.map((r) => [
      r.code,
      r.category,
      r.name,
      r.brand,
      packSizeLabel(r),
      r.unit,
      rupees(r.mrpPaise),
      null,
      null,
      // The owner only has to fill in stock; loose goods have no ready price.
      r.kind === "LOOSE" ? null : rupees(r.mrpPaise),
      null,
    ]),
  );
}

/** The shop's current listings, to edit and upload again. */
export async function buildMyProducts(shopId: string, format: "xlsx" | "csv", actor: SetupActor): Promise<BulkDownload> {
  const shop = await assertCanManageShopCategories(shopId, actor);
  const listings = await listShopListings(shopId);
  return download(
    `my-products-${safeName(shop.name)}`,
    format,
    BULK_HEADERS,
    listings.map((l) => [
      l.code,
      l.categoryName,
      l.name,
      l.brandName,
      l.packSize,
      l.unit,
      rupees(l.masterMrpPaise),
      "Yes",
      rupees(l.shopMrpPaise),
      rupees(l.pricePaise),
      l.stock,
    ]),
  );
}

/* ---------------------------------------------------------------- upload */

interface PlanRow {
  row: number;
  productId: string;
  code: string;
  kind: ProductKind;
  shopProductId: string | null;
  action: "create" | "revive" | "update" | "pause";
  stock: number | null;
  pricePaise: number | null;
  shopMrpPaise: number | null;
  /** A paused listing marked Yes goes back on sale. */
  resume?: boolean;
}

export interface UploadError {
  row: number;
  message: string;
  cells: CellValue[];
}

const EMPTY_COUNTS = { totalRows: 0, goLive: 0, needsStock: 0, needsPrice: 0, update: 0, pause: 0, outOfStock: 0, errors: 0, ignored: 0, unchanged: 0 };
export type UploadCounts = typeof EMPTY_COUNTS;

export async function assertUploadAccess(shopId: string, actor: SetupActor): Promise<void> {
  await assertCanManageShopCategories(shopId, actor);
}

export async function createUpload(shopId: string, file: { name: string; bytes: Buffer }, actor: SetupActor): Promise<ShopBulkUpload> {
  await assertCanManageShopCategories(shopId, actor);
  const limits = await getImportLimits();
  if (!limits.enabled) throw validationFailed("Uploads are switched off at the moment.");
  const name = file.name.trim().slice(0, 200) || "upload";
  if (!/\.(xlsx|csv)$/i.test(name)) throw validationFailed("Upload the Excel (.xlsx) or CSV file you downloaded from this page.");
  if (file.bytes.length === 0) throw validationFailed("The file is empty.");
  if (file.bytes.length > limits.maxFileBytes) {
    throw validationFailed(`The file is too large. The limit is ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB.`);
  }
  const fileSha256 = createHash("sha256").update(file.bytes).digest("hex");
  const [repeat] = await db
    .select({ createdAt: shopBulkUploads.createdAt })
    .from(shopBulkUploads)
    .where(
      and(
        eq(shopBulkUploads.shopId, shopId),
        eq(shopBulkUploads.fileSha256, fileSha256),
        inArray(shopBulkUploads.status, ["APPLYING", "DONE"]),
        gt(shopBulkUploads.createdAt, new Date(Date.now() - REPEAT_WINDOW_MS)),
      ),
    )
    .limit(1);
  if (repeat) throw conflict("This exact file was already imported today, so it was not applied again.");
  const [upload] = await db
    .insert(shopBulkUploads)
    .values({ shopId, uploadedBy: actor.id, fileName: name, fileSha256, fileData: file.bytes })
    .returning();
  return upload;
}

function text(cell: CellValue | undefined): string {
  return cell == null ? "" : String(cell).trim();
}

/** Blank → undefined; a number → itself; anything else → NaN. Understands ₹ and commas. */
function number(cell: CellValue | undefined): number | undefined {
  if (cell == null || text(cell) === "") return undefined;
  if (typeof cell === "number") return cell;
  const n = Number(text(cell).replace(/[₹,\s]/g, "").replace(/^rs\.?/i, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

const headerKey = (h: CellValue | undefined) => text(h).toLowerCase().replace(/\s+/g, " ");

async function reject(uploadId: string, failure: string): Promise<void> {
  await db
    .update(shopBulkUploads)
    .set({ status: "REJECTED", failure, fileData: null, finishedAt: new Date(), lastProgressAt: new Date() })
    .where(eq(shopBulkUploads.id, uploadId));
}

/** Reads the file and builds the preview. Changes nothing in the shop. */
export async function checkUpload(uploadId: string): Promise<void> {
  const [upload] = await db.select().from(shopBulkUploads).where(eq(shopBulkUploads.id, uploadId));
  if (!upload || upload.status !== "CHECKING" || !upload.fileData) return;
  const limits = await getImportLimits();
  let grid;
  try {
    grid = await readSpreadsheet(Buffer.from(upload.fileData), upload.fileName, { maxRows: limits.maxRows + 1 });
  } catch (error) {
    if (error instanceof AppError) return reject(uploadId, error.message);
    throw error;
  }
  const [header, ...rows] = grid.rows;
  const positions = BULK_HEADERS.map((h) => (header?.cells ?? []).findIndex((c) => headerKey(c) === h.toLowerCase()));
  if (positions.some((p) => p < 0)) {
    return reject(uploadId, "This is not the GoKesari product file. Download the template from this page, fill it in and upload that.");
  }
  const dataRows = rows
    .map((r) => ({ row: r.rowNumber, cells: positions.map((p) => r.cells[p] ?? null) }))
    .filter((r) => r.cells.some((c) => text(c) !== ""));
  if (grid.truncated || dataRows.length > limits.maxRows) {
    return reject(uploadId, `This file has too many rows. The limit is ${limits.maxRows.toLocaleString("en-IN")} products per file.`);
  }

  const idOf = (cells: CellValue[]) => text(cells[COL.id]).replace(/^'/, "").toUpperCase();
  const codes = [...new Set(dataRows.map((r) => idOf(r.cells)).filter(Boolean))];
  const seen = new Map<string, number>();
  for (const r of dataRows) seen.set(idOf(r.cells), (seen.get(idOf(r.cells)) ?? 0) + 1);

  const masters = new Map<string, { id: string; kind: ProductKind; mrpPaise: number | null; categoryName: string; carried: boolean }>();
  const listings = new Map<string, typeof shopProducts.$inferSelect & { shopMrpPaise: number | null; categoryCarried: boolean }>();
  for (let i = 0; i < codes.length; i += 1000) {
    const chunk = codes.slice(i, i + 1000);
    const found = await db
      .select({
        id: products.id,
        code: products.code,
        kind: products.kind,
        mrpPaise: products.mrpPaise,
        categoryName: productCategories.name,
        carried: sql<boolean>`${shopCarriesProductCategory(upload.shopId, products.categoryId)}`,
      })
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(
        and(
          inArray(sql`upper(${products.code})`, chunk),
          isNull(products.deletedAt),
          eq(products.isActive, true),
          eq(products.approvalStatus, "APPROVED"),
        ),
      );
    for (const f of found) masters.set(f.code.toUpperCase(), f);
    const ids = found.map((f) => f.id);
    if (!ids.length) continue;
    const own = await db
      .select({
        sp: shopProducts,
        shopMrpPaise: shopListingDetails.mrpPaise,
        categoryCarried: sql<boolean>`${shopCarriesProductCategory(upload.shopId, products.categoryId)}`,
      })
      .from(shopProducts)
      .innerJoin(products, eq(products.id, shopProducts.productId))
      .leftJoin(shopListingDetails, eq(shopListingDetails.shopProductId, shopProducts.id))
      .where(and(eq(shopProducts.shopId, upload.shopId), inArray(shopProducts.productId, ids)));
    for (const o of own) listings.set(o.sp.productId, { ...o.sp, shopMrpPaise: o.shopMrpPaise, categoryCarried: o.categoryCarried });
  }

  const counts = { ...EMPTY_COUNTS, totalRows: dataRows.length };
  const errors: UploadError[] = [];
  const plan: PlanRow[] = [];

  for (const { row, cells } of dataRows) {
    const fail = (message: string) => {
      errors.push({ row, message, cells });
      counts.errors += 1;
    };
    const code = idOf(cells);
    if (!code) { fail("Product ID is missing."); continue; }
    if ((seen.get(code) ?? 0) > 1) { fail(`Product ID ${code} appears more than once in this file. Keep one row.`); continue; }
    const master = masters.get(code);
    if (!master) { fail(`Product ID ${code} is not in the GoKesari product list. Add it as a new product instead.`); continue; }

    const include = text(cells[COL.include]).toLowerCase();
    if (include && !["yes", "no", "y", "n"].includes(include)) { fail("Include must be Yes or No."); continue; }
    const yes = include === "yes" || include === "y";
    const no = include === "no" || include === "n";
    const listing = listings.get(master.id);
    const active = listing && !listing.deletedAt ? listing : null;

    if (!yes && !active) { counts.ignored += 1; continue; }
    if (!include) { counts.unchanged += 1; continue; }
    if (no) {
      if (active!.ownerPaused) { counts.unchanged += 1; continue; }
      plan.push({ row, productId: master.id, code, kind: master.kind, shopProductId: active!.id, action: "pause", stock: null, pricePaise: null, shopMrpPaise: null });
      counts.pause += 1;
      continue;
    }

    const price = number(cells[COL.price]);
    const stock = number(cells[COL.stock]);
    const shopMrp = number(cells[COL.shopMrp]);
    if (Number.isNaN(price)) { fail("Selling Price must be a number."); continue; }
    if (Number.isNaN(stock)) { fail("Stock Quantity must be a number."); continue; }
    if (Number.isNaN(shopMrp)) { fail("Shop MRP must be a number."); continue; }
    if (shopMrp !== undefined && shopMrp <= 0) { fail("Shop MRP must be more than 0."); continue; }
    if (price !== undefined && price <= 0) { fail("Selling Price must be more than 0."); continue; }
    const pricePaise = price === undefined ? null : rupeesToPaise(price);
    const shopMrpPaise = shopMrp === undefined ? null : rupeesToPaise(shopMrp);
    const mrpLimit = shopMrpPaise ?? listing?.shopMrpPaise ?? (master.kind === "PACKAGED" ? master.mrpPaise : null);
    const problem = listingValueProblem({ kind: master.kind, pricePaise, stock: stock ?? null, mrpPaise: mrpLimit });
    if (problem) { fail(problem); continue; }
    if (!master.carried && !active) { fail(`Add the category "${master.categoryName}" to your shop first.`); continue; }

    const base = { row, productId: master.id, code, kind: master.kind, stock: stock ?? null, pricePaise, shopMrpPaise };
    if (active) {
      const resume = active.ownerPaused;
      const changed =
        resume ||
        (pricePaise != null && pricePaise !== active.onlinePricePaise) ||
        (stock !== undefined && (roundStock(stock) !== active.onlineStock || active.stockPending)) ||
        (shopMrpPaise != null && shopMrpPaise !== active.shopMrpPaise);
      if (!changed) { counts.unchanged += 1; continue; }
      plan.push({ ...base, shopProductId: active.id, action: "update", resume });
      counts.update += 1;
      continue;
    }
    plan.push({ ...base, shopProductId: listing?.id ?? null, action: listing ? "revive" : "create" });
    if (stock === undefined) counts.needsStock += 1;
    else if (pricePaise == null) counts.needsPrice += 1;
    else if (stock <= 0) counts.outOfStock += 1;
    else counts.goLive += 1;
  }

  await db
    .update(shopBulkUploads)
    .set({
      status: "READY",
      counts,
      plan,
      errors,
      headers: [...BULK_HEADERS],
      totalRows: plan.length,
      fileData: null,
      lastProgressAt: new Date(),
    })
    .where(and(eq(shopBulkUploads.id, uploadId), eq(shopBulkUploads.status, "CHECKING")));
}

/* ---------------------------------------------------------------- views */

export interface UploadView {
  id: string;
  fileName: string;
  status: ShopBulkUpload["status"];
  failure: string | null;
  counts: UploadCounts;
  errors: UploadError[];
  errorCount: number;
  totalRows: number;
  appliedRows: number;
  result: Record<string, number> | null;
  createdAt: string;
  finishedAt: string | null;
}

const PREVIEW_ERRORS = 200;

function toView(u: ShopBulkUpload): UploadView {
  const errors = u.errors as UploadError[];
  return {
    id: u.id,
    fileName: u.fileName,
    status: u.status,
    failure: u.failure,
    counts: { ...EMPTY_COUNTS, ...u.counts },
    errors: errors.slice(0, PREVIEW_ERRORS),
    errorCount: errors.length,
    totalRows: u.totalRows,
    appliedRows: u.appliedRows,
    result: u.result,
    createdAt: u.createdAt.toISOString(),
    finishedAt: u.finishedAt?.toISOString() ?? null,
  };
}

/** Loads an upload of this shop; another shop's upload simply does not exist for the caller. */
async function loadUpload(shopId: string, uploadId: string, actor: SetupActor): Promise<ShopBulkUpload> {
  await assertCanManageShopCategories(shopId, actor);
  const [upload] = await db
    .select()
    .from(shopBulkUploads)
    .where(and(eq(shopBulkUploads.id, uploadId), eq(shopBulkUploads.shopId, shopId)));
  if (!upload) throw notFound("Upload");
  return upload;
}

export async function getUploadView(shopId: string, uploadId: string, actor: SetupActor): Promise<UploadView> {
  return toView(await loadUpload(shopId, uploadId, actor));
}

/** True (once) when the work behind this upload stopped, so the caller should start it again. */
export async function claimStalledUpload(shopId: string, uploadId: string, actor: SetupActor): Promise<"CHECKING" | "APPLYING" | null> {
  const upload = await loadUpload(shopId, uploadId, actor);
  if (upload.status !== "CHECKING" && upload.status !== "APPLYING") return null;
  if (Date.now() - upload.lastProgressAt.getTime() < STALLED_MS) return null;
  const claimed = await db
    .update(shopBulkUploads)
    .set({ lastProgressAt: new Date() })
    .where(and(eq(shopBulkUploads.id, uploadId), eq(shopBulkUploads.lastProgressAt, upload.lastProgressAt)))
    .returning({ id: shopBulkUploads.id });
  return claimed.length ? upload.status : null;
}

export async function listUploadHistory(shopId: string, actor: SetupActor) {
  await assertCanManageShopCategories(shopId, actor);
  const rows = await db
    .select({ upload: shopBulkUploads, uploadedByName: users.name })
    .from(shopBulkUploads)
    .leftJoin(users, eq(users.id, shopBulkUploads.uploadedBy))
    .where(eq(shopBulkUploads.shopId, shopId))
    .orderBy(desc(shopBulkUploads.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.upload.id,
    fileName: r.upload.fileName,
    status: r.upload.status,
    counts: { ...EMPTY_COUNTS, ...r.upload.counts },
    uploadedBy: r.uploadedByName ?? "—",
    createdAtIst: r.upload.createdAt.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
  }));
}

export async function buildErrorFile(shopId: string, uploadId: string, actor: SetupActor): Promise<BulkDownload> {
  const upload = await loadUpload(shopId, uploadId, actor);
  const errors = upload.errors as UploadError[];
  const headers = [...BULK_HEADERS, "Error"];
  return download(
    `errors-${safeName(upload.fileName.replace(/\.[^.]+$/, ""))}`,
    upload.fileName.toLowerCase().endsWith(".csv") ? "csv" : "xlsx",
    headers,
    errors.map((e) => [...BULK_HEADERS.map((_, i) => (typeof e.cells[i] === "boolean" ? String(e.cells[i]) : (e.cells[i] as string | number | null))), e.message]),
  );
}

export async function cancelUpload(shopId: string, uploadId: string, actor: SetupActor): Promise<UploadView> {
  await loadUpload(shopId, uploadId, actor);
  const [row] = await db
    .update(shopBulkUploads)
    .set({ status: "CANCELLED", plan: null, finishedAt: new Date() })
    .where(and(eq(shopBulkUploads.id, uploadId), eq(shopBulkUploads.status, "READY")))
    .returning();
  if (!row) throw conflict("This upload can no longer be cancelled.");
  return toView(row);
}

/* ----------------------------------------------------------------- apply */

/** Moves READY → APPLYING exactly once; a repeated confirm changes nothing and reports where it stands. */
export async function confirmUpload(
  shopId: string,
  uploadId: string,
  options: { confirmPause: boolean },
  actor: SetupActor,
): Promise<{ view: UploadView; started: boolean }> {
  const before = await loadUpload(shopId, uploadId, actor);
  const [claimed] = await db
    .update(shopBulkUploads)
    .set({ status: "APPLYING", pauseConfirmed: options.confirmPause, lastProgressAt: new Date() })
    .where(and(eq(shopBulkUploads.id, uploadId), eq(shopBulkUploads.status, "READY")))
    .returning();
  if (claimed) return { view: toView(claimed), started: true };
  if (before.status === "APPLYING" || before.status === "DONE") return { view: toView(before), started: false };
  throw conflict("This upload cannot be imported. Upload the file again.");
}

async function applyRow(row: PlanRow, upload: ShopBulkUpload, actor: SetupActor, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<string | null> {
  const listingActor = actor as { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" };
  if (row.action === "pause") {
    if (!upload.pauseConfirmed) return row.shopProductId;
    await setListingPaused(upload.shopId, row.shopProductId!, true, actor, tx);
    return row.shopProductId;
  }
  const priced = row.pricePaise != null;
  if (row.action === "create") {
    const [created] = await tx
      .insert(shopProducts)
      .values({
        shopId: upload.shopId,
        productId: row.productId,
        onlinePricePaise: row.pricePaise,
        offlinePricePaise: row.pricePaise,
        onlineSaleEnabled: priced,
        offlineSaleEnabled: priced,
        onlineStock: row.stock == null ? 0 : roundStock(row.stock),
        offlineStock: 0,
        stockPending: row.stock == null,
      })
      .onConflictDoNothing()
      .returning({ id: shopProducts.id });
    if (!created) throw conflict("This product was added to your shop while the file was being imported.");
    if (row.shopMrpPaise != null) await setShopMrp(created.id, upload.shopId, row.shopMrpPaise, actor, tx);
    return created.id;
  }
  if (row.action === "revive") {
    await tx
      .update(shopProducts)
      .set({ deletedAt: null, isActive: true, isAvailable: true, ownerPaused: false, onlineSaleEnabled: sql`${shopProducts.onlinePricePaise} IS NOT NULL`, offlineSaleEnabled: sql`${shopProducts.offlinePricePaise} IS NOT NULL`, updatedAt: new Date() })
      .where(and(eq(shopProducts.id, row.shopProductId!), eq(shopProducts.shopId, upload.shopId)));
  }
  const id = row.shopProductId!;
  if (row.shopMrpPaise != null) await setShopMrp(id, upload.shopId, row.shopMrpPaise, actor, tx);
  const patch: Parameters<typeof updateShopProduct>[1] = {};
  if (row.pricePaise != null) {
    patch.onlinePricePaise = row.pricePaise;
    patch.offlinePricePaise = row.pricePaise;
    patch.onlineSaleEnabled = true;
    patch.offlineSaleEnabled = true;
  }
  if (row.stock != null) patch.onlineStock = roundStock(row.stock);
  if (Object.keys(patch).length) await updateShopProduct(id, patch, listingActor, tx);
  // After the stock, which decides whether it can actually be bought.
  if (row.resume) await setListingPaused(upload.shopId, id, false, actor, tx);
  if (row.stock != null) await tx.update(shopProducts).set({ stockPending: false }).where(eq(shopProducts.id, id));
  else if (row.action === "revive") {
    await tx.update(shopProducts).set({ stockPending: sql`${shopProducts.onlineStock} <= 0 AND ${shopProducts.offlineStock} <= 0` }).where(eq(shopProducts.id, id));
  }
  return id;
}

/** Applies the confirmed rows in batches; picks up after the last finished batch if it was interrupted. */
export async function applyUpload(uploadId: string, actor: SetupActor): Promise<void> {
  const [upload] = await db.select().from(shopBulkUploads).where(eq(shopBulkUploads.id, uploadId));
  if (!upload || upload.status !== "APPLYING") return;
  const plan = (upload.plan ?? []) as PlanRow[];
  const errors = [...(upload.errors as UploadError[])];
  const touched: string[] = [];
  let applied = upload.appliedRows;

  try {
    while (applied < plan.length) {
      const batch = plan.slice(applied, applied + APPLY_BATCH);
      const failed: UploadError[] = [];
      const batchIds: string[] = [];
      await db.transaction(async (tx) => {
        for (const row of batch) {
          try {
            // Each row in its own savepoint: one bad row never undoes its neighbours.
            const id = await tx.transaction((inner) => applyRow(row, upload, actor, inner));
            if (id) batchIds.push(id);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            failed.push({ row: row.row, message: error.message, cells: [row.code] });
          }
        }
        await tx
          .update(shopBulkUploads)
          .set({ appliedRows: applied + batch.length, lastProgressAt: new Date(), errors: [...errors, ...failed] })
          .where(eq(shopBulkUploads.id, uploadId));
      });
      errors.push(...failed);
      touched.push(...batchIds);
      applied += batch.length;
    }
  } catch (error) {
    console.error("[shop-bulk-upload] apply failed", uploadId, error);
    await db
      .update(shopBulkUploads)
      .set({ status: "FAILED", failure: "The import stopped part-way. The rows already saved are kept. Upload the file again to finish.", finishedAt: new Date() })
      .where(eq(shopBulkUploads.id, uploadId));
    return;
  }

  const ids = new Set(touched);
  const statuses = (await listShopListings(upload.shopId)).filter((l) => ids.has(l.shopProductId));
  const count = (...s: string[]) => statuses.filter((l) => s.includes(l.status)).length;
  const result = {
    live: count("LIVE"),
    needsStockOrPrice: count("NEEDS_STOCK", "NEEDS_PRICE"),
    outOfStock: count("OUT_OF_STOCK"),
    paused: count("PAUSED"),
    errors: errors.length,
  };
  await db
    .update(shopBulkUploads)
    .set({ status: "DONE", result, plan: null, finishedAt: new Date(), lastProgressAt: new Date() })
    .where(eq(shopBulkUploads.id, uploadId));
  await saveSetupStep(upload.shopId, 3, actor);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_CREATED,
    entityType: "shop",
    entityId: upload.shopId,
    newValue: { source: "product_setup_upload", uploadId, ...result },
  });
  if (result.live > 0) await checkCommissionMilestonesSafely(upload.shopId);
  const [shop] = await db.select({ name: shops.name, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, upload.shopId));
  if (shop) {
    await notify({
      type: NOTIFICATION_TYPES.SHOP_BULK_UPLOAD_FINISHED,
      userId: shop.ownerId,
      vars: { shopName: shop.name, fileName: upload.fileName, live: result.live, needs: result.needsStockOrPrice, errors: result.errors },
      dedupeKey: `shop-bulk-upload:${uploadId}`,
    });
  }
}

