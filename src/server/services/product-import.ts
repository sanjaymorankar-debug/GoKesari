/**
 * Bulk product upload (docs/product-import-2026-10).
 *
 * One more way to load products — the manual add, add-by-category and the
 * Excel price upload are untouched. A shop owner (or an operator/admin for any
 * shop) uploads one spreadsheet; its rows create or update the shop's listings
 * and set the shop's stock to the file's Quantity.
 *
 *   1. createImportJob   stores the file (status uploaded) — nothing else.
 *   2. runParse          (after the response) reads the file, plans every row
 *                        against the catalogue and stages it → preview_ready.
 *                        Still nothing written outside the import tables.
 *   3. startCommit       claims the job with the chosen inventory mode.
 *   4. runCommit         (after the response) writes the rows `batchSize` at a
 *                        time, each batch in its own transaction and each row
 *                        in its own savepoint, so a failing row is marked
 *                        failed and nothing else is rolled back. Then the
 *                        owner (and the operator/admin who ran it) is
 *                        notified, and product images are downloaded.
 *
 * Rules (all from the brief):
 *  - every field is optional; problems are warnings on the row;
 *  - a blank cell never wipes saved data;
 *  - prices and MRP from the file go on the shop's listing only — never on
 *    the master catalogue; a price above the MRP is not applied;
 *  - an operator's prices follow the existing rule: they are proposed to the
 *    shop owner (price requests), never applied directly;
 *  - every stock change writes an inventory_movements row (source
 *    bulk_upload, the job, the user), under the listing's row lock, so an
 *    order placed during the import is never lost;
 *  - Delete deactivates the listing (hidden, stock 0) — never a hard delete,
 *    never the master product.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { roundStock } from "@/lib/stock-quantity";
import {
  EMPTY_COUNTS,
  plannedStock,
  type ImportCounts,
  type ImportRowAction,
  type ImportRowPlan,
  type ImportRowStatus,
  type InventoryMode,
} from "@/lib/product-import";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, isSerializationFailure, type DbClient } from "@/server/db";
import {
  brands,
  inventoryMovements,
  productAttributes,
  productCategories,
  productImportJobs,
  productImportRows,
  products,
  shopListingDetails,
  shopProducts,
  shops,
  users,
  type ProductImportJob,
  type ProductImportRow,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { processProductPhoto } from "@/server/media/photo-pipeline";
import type { ImportFields } from "@/server/product-import/fields";
import { fetchImage, ImageFetchError, type ImageFetcher } from "@/server/product-import/image-fetch";
import { CatalogueMatcher, type ListingRef, type ProductRef } from "@/server/product-import/matcher";
import { gtinDigits, matchKey } from "@/server/product-import/normalise";
import { parseImportFile, type ParsedRow } from "@/server/product-import/parse";
import { buildSimpleTemplate, reportCsv, reportXlsx, TEMPLATE_FILE_NAME } from "@/server/product-import/workbooks";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { updateShopProduct, uniqueSlug } from "./catalogue";
import { discardPhotoBlobs, storePhotoBlobs } from "./image-store";
import { evaluateStockAlerts } from "./inventory-alerts";
import { checkPriceAgainstMrp } from "./mrp-governance";
import { appliesImmediately, submitPriceRequests, type ProposedChange } from "./price-requests";
import { addCategoryToShop, ensureGeneralCategory } from "./product-categories";
import { initialStatus, listImages } from "./product-images";
import { getRule } from "./settings";
import { attachProcessedPhoto, lockListing } from "./shop-media";

export interface ImportActor {
  id: string;
  role: UserRole;
}

/** An import with no progress for this long (the server restarted) may be resumed. */
const STALLED_AFTER_MS = 5 * 60_000;
const ROW_INSERT_CHUNK = 500;
/** Largest stock a row may set (shop_products.online_stock is numeric(14, 3)). */
const MAX_STOCK = 1_000_000_000;

/* ================================================================ access */

/**
 * The shop owner (own shops only) or an operator/admin (any shop). Staff
 * accounts of a shop are not included: stock and prices are the owner's.
 */
export async function assertImportAccess(shopId: string, actor: ImportActor, client: DbClient = db): Promise<{ ownerId: string; shopName: string; isOwner: boolean }> {
  const [shop] = await client
    .select({ id: shops.id, ownerId: shops.ownerId, name: shops.name })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId === actor.id && can(actor.role, PERMISSIONS.EXCEL_UPLOAD_OWN)) {
    return { ownerId: shop.ownerId, shopName: shop.name, isOwner: true };
  }
  if (can(actor.role, PERMISSIONS.EXCEL_UPLOAD_ANY)) return { ownerId: shop.ownerId, shopName: shop.name, isOwner: false };
  throw forbidden("You can upload products only for your own shop.");
}

/** Loads a job the actor may see (a job of another shop is "not found" to a shop owner). */
export async function loadJobForActor(jobId: string, actor: ImportActor): Promise<ProductImportJob> {
  const [job] = await db.select().from(productImportJobs).where(eq(productImportJobs.id, jobId));
  if (!job) throw notFound("Upload");
  try {
    await assertImportAccess(job.shopId, actor);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) throw notFound("Upload");
    throw error;
  }
  return job;
}

export async function getImportLimits() {
  return getRule("productImport");
}

/* ================================================================ upload */

export interface UploadedFile {
  name: string;
  bytes: Buffer;
}

const ACCEPTED_NAME = /\.(xlsx|xlsm|csv)$/i;

export async function createImportJob(
  shopId: string,
  file: UploadedFile,
  actor: ImportActor,
): Promise<{ job: ImportJobView; duplicateOf: { jobId: string; importedAt: string } | null }> {
  await assertImportAccess(shopId, actor);
  const limits = await getImportLimits();
  if (!limits.enabled) throw validationFailed("Bulk upload is switched off at the moment.");
  const name = file.name.trim().slice(0, 200) || "upload";
  if (!ACCEPTED_NAME.test(name)) throw validationFailed("Upload an Excel file (.xlsx or .xlsm) or a CSV file.");
  if (file.bytes.length === 0) throw validationFailed("The file is empty.");
  if (file.bytes.length > limits.maxFileBytes) {
    throw validationFailed(`The file is too large: the limit is ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB.`);
  }
  const fileHash = createHash("sha256").update(file.bytes).digest("hex");
  const [previous] = await db
    .select({ id: productImportJobs.id, finishedAt: productImportJobs.finishedAt })
    .from(productImportJobs)
    .where(and(eq(productImportJobs.shopId, shopId), eq(productImportJobs.fileHash, fileHash), eq(productImportJobs.status, "completed")))
    .orderBy(desc(productImportJobs.finishedAt))
    .limit(1);

  const [job] = await db
    .insert(productImportJobs)
    .values({
      shopId,
      userId: actor.id,
      actorRole: actor.role,
      fileName: name,
      fileHash,
      fileSizeBytes: file.bytes.length,
      fileData: file.bytes,
      status: "uploaded",
      counts: EMPTY_COUNTS,
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_IMPORT_UPLOADED,
    entityType: "product_import_job",
    entityId: job.id,
    newValue: { shopId, fileName: name, bytes: file.bytes.length, fileHash, duplicateOf: previous?.id ?? null },
  });
  return {
    job: await getJobView(job.id),
    duplicateOf: previous ? { jobId: previous.id, importedAt: (previous.finishedAt ?? new Date()).toISOString() } : null,
  };
}

/* ================================================================ parse + plan */

interface StagedRow {
  rowNumber: number;
  sku: string | null;
  rawJson: Record<string, unknown>;
  parsedJson: Record<string, unknown>;
  action: ImportRowAction;
  matchType: "SKU" | "BARCODE" | "NAME" | "NEW" | "NONE" | null;
  productId: string | null;
  listingId: string | null;
  plan: ImportRowPlan | null;
  status: ImportRowStatus;
  messages: string[];
  mergedRows: number[];
}

/** Later non-blank values win; arrays and objects are replaced whole. */
function mergeFields(earlier: ImportFields, later: ImportFields): ImportFields {
  const out: Record<string, unknown> = { ...earlier };
  for (const [k, v] of Object.entries(later)) {
    if (v == null) continue;
    out[k] = v;
  }
  // A valid quantity in the later row supersedes an invalid earlier one and vice versa.
  if (later.quantity != null) delete out.quantityInvalid;
  return out as ImportFields;
}

function mergeAttributes(a: Record<string, Record<string, unknown>>, b: Record<string, Record<string, unknown>>) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const src of [a, b]) for (const [g, bag] of Object.entries(src)) out[g] = { ...(out[g] ?? {}), ...bag };
  return out;
}

/** Groups rows by SKU: the last row of each group carries the merge. Returns the staged rows in file order. */
function mergeDuplicateSkus(rows: ParsedRow[]): { row: ParsedRow; mergedInto: number | null; merged: ParsedRow[] }[] {
  const lastBySku = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.fields.sku) lastBySku.set(r.fields.sku.trim().toLowerCase(), i);
  });
  const groups = new Map<number, ParsedRow[]>();
  const out: { row: ParsedRow; mergedInto: number | null; merged: ParsedRow[] }[] = [];
  rows.forEach((r, i) => {
    const key = r.fields.sku?.trim().toLowerCase();
    const last = key ? lastBySku.get(key)! : i;
    if (last !== i) {
      const list = groups.get(last) ?? [];
      list.push(r);
      groups.set(last, list);
      out.push({ row: r, mergedInto: rows[last].rowNumber, merged: [] });
    } else {
      out.push({ row: r, mergedInto: null, merged: groups.get(i) ?? [] });
    }
  });
  return out;
}

interface PlanContext {
  matcher: CatalogueMatcher;
  categories: Map<string, { id: string; name: string }>;
  general: { id: string; name: string };
  productNames: Map<string, string>;
}

function resolveCategory(f: ImportFields, ctx: Pick<PlanContext, "categories" | "general">): { id: string; name: string; matched: boolean } {
  for (const hint of f.categoryHints ?? []) {
    const found = ctx.categories.get(matchKey(hint)) ?? ctx.categories.get(matchKey(hint.replace(/s$/i, "")));
    if (found) return { ...found, matched: true };
  }
  if (f.productType) {
    const found = ctx.categories.get(matchKey(f.productType)) ?? ctx.categories.get(matchKey(f.productType.replace(/s$/i, "")));
    if (found) return { ...found, matched: true };
  }
  return { ...ctx.general, matched: false };
}

async function loadCategories(client: DbClient) {
  const general = await ensureGeneralCategory(client);
  const rows = await client
    .select({ id: productCategories.id, name: productCategories.name })
    .from(productCategories)
    .where(and(isNull(productCategories.deletedAt), eq(productCategories.isActive, true)));
  const categories = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    categories.set(matchKey(r.name), r);
    categories.set(matchKey(r.name.replace(/s$/i, "")), r);
  }
  return { categories, general: { id: general.id, name: general.name } };
}

function quantities(staged: { fields: ImportFields; merged: ImportFields[] }): { last: number | null; sum: number | null } {
  const all = [...staged.merged, staged.fields].map((f) => f.quantity).filter((q): q is number => q != null);
  if (all.length === 0) return { last: null, sum: null };
  return { last: all[all.length - 1], sum: all.reduce((a, b) => a + b, 0) };
}

/** Plans one (merged) row against the catalogue: what the commit will do. Pure apart from the matcher's in-memory index. */
function planRow(f: ImportFields, mergedFields: ImportFields[], ctx: PlanContext): Omit<StagedRow, "rowNumber" | "rawJson" | "parsedJson" | "mergedRows"> & { messages: string[] } {
  const messages: string[] = [];
  const action: ImportRowAction = f.action ?? "UPSERT";
  const res = ctx.matcher.resolve(f);
  const q = quantities({ fields: f, merged: mergedFields });
  const listing = res.listing && !(res.listing.deleted && action !== "UPSERT") ? res.listing : null;
  const brand = f.brand ?? res.product?.brand ?? null;
  const categoryForNew = resolveCategory(f, ctx);
  const plan: ImportRowPlan = {
    outcome: "skip",
    sku: f.sku ?? listing?.sellerSku ?? null,
    name: f.name ?? (res.product ? res.product.name : null) ?? (listing ? (ctx.productNames.get(listing.productId) ?? null) : null),
    brand,
    category: res.product ? null : categoryForNew.name,
    mrpPaise: f.mrpPaise ?? null,
    pricePaise: f.pricePaise ?? null,
    currentQty: listing && !listing.virtual ? listing.onlineStock : listing ? 0 : null,
    fileQty: q.last,
    fileQtySum: q.sum,
  };
  const base = { action, productId: res.product?.virtual ? null : (res.product?.id ?? listing?.productId ?? null), listingId: listing && !listing.virtual ? listing.id : null };
  if (q.last != null && !Number.isInteger(q.last)) {
    messages.push(`Quantity ${q.last} has decimals: it applies to a loose product (kg, litre); a packaged product's stock is left unchanged.`);
  }

  if (res.matchType === "NAME") messages.push(`Matched by name and brand to catalogue product ${res.product?.code || ""} "${res.product?.name ?? ""}".`.replace("  ", " "));
  if (res.matchType === "BARCODE" && res.product && !res.product.virtual) messages.push(`Matched by barcode to catalogue product ${res.product.code} "${res.product.name}".`);

  if (action === "DELETE") {
    if (!listing || listing.deleted) {
      messages.push("Delete: no matching product in this shop; row skipped.");
      return { ...base, matchType: listing ? res.matchType : "NONE", plan: { ...plan, outcome: "skip" }, status: "skipped", sku: f.sku ?? null, messages };
    }
    messages.push("Delete: the product will be hidden from customers and its stock set to 0 (not deleted).");
    return { ...base, matchType: res.matchType, plan: { ...plan, outcome: "deactivate", currentQty: listing.onlineStock }, status: "ready", sku: f.sku ?? null, messages };
  }
  if (action === "EDIT" && (!listing || listing.deleted)) {
    messages.push("Edit (partial update): no matching product in this shop; row skipped.");
    return { ...base, matchType: "NONE", plan: { ...plan, outcome: "skip" }, status: "skipped", sku: f.sku ?? null, messages };
  }

  if (listing && !listing.deleted) {
    if (f.quantityInvalid == null && q.last == null) messages.push("No quantity: stock stays as it is.");
    return { ...base, matchType: res.matchType, plan: { ...plan, outcome: "update" }, status: "ready", sku: f.sku ?? null, messages };
  }

  // A new listing: of a catalogue product, or of a new product.
  if (!res.product) {
    messages.push("New product: added to the GoKesari catalogue as Pending approval; you can sell it in your shop straight away.");
    if (!categoryForNew.matched) {
      const hint = f.categoryHints?.[0] ?? f.productType;
      messages.push(`${hint ? `No GoKesari category matches "${hint}"` : "No category given"}; the product goes in "${ctx.general.name}" (uncategorised).`);
    }
    if (!f.name) messages.push("No product name: a placeholder name will be used — edit it later.");
  } else if (listing?.deleted) {
    messages.push("This product was removed from your shop earlier; it will be listed again.");
  }
  if (!f.sku) messages.push("No SKU: one will be generated (GK-…).");
  if (q.last == null) messages.push("No quantity: the product is not orderable until stock is set.");
  return { ...base, matchType: res.product ? res.matchType : "NEW", plan: { ...plan, outcome: "create", currentQty: listing?.deleted ? listing.onlineStock : null }, status: "ready", sku: f.sku ?? null, messages };
}

/** Claims an uploaded job and parses + plans it. Run after the upload response. */
export async function runParse(jobId: string): Promise<void> {
  const [claimed] = await db
    .update(productImportJobs)
    .set({ status: "parsing", startedAt: new Date(), lastProgressAt: new Date(), updatedAt: new Date() })
    .where(and(eq(productImportJobs.id, jobId), eq(productImportJobs.status, "uploaded")))
    .returning();
  if (!claimed) return;
  try {
    if (!claimed.fileData) throw validationFailed("The file for this upload is no longer stored.");
    const limits = await getImportLimits();
    const parsed = await parseImportFile(claimed.fileData, claimed.fileName, { maxRows: limits.maxRows });
    const grouped = mergeDuplicateSkus(parsed.rows);

    const { categories, general } = await loadCategories(db);
    const matcher = await CatalogueMatcher.load(claimed.shopId, parsed.rows.map((r) => r.fields));
    const productNames = new Map(
      (
        await db
          .select({ id: products.id, name: products.name })
          .from(products)
          .innerJoin(shopProducts, eq(shopProducts.productId, products.id))
          .where(eq(shopProducts.shopId, claimed.shopId))
      ).map((r) => [r.id, r.name]),
    );
    const ctx: PlanContext = { matcher, categories, general, productNames };

    const staged: StagedRow[] = [];
    for (const g of grouped) {
      const rawJson = g.row.raw as Record<string, unknown>;
      if (g.mergedInto != null) {
        staged.push({
          rowNumber: g.row.rowNumber,
          sku: g.row.fields.sku ?? null,
          rawJson,
          parsedJson: { fields: g.row.fields, attributes: g.row.attributes },
          action: g.row.fields.action ?? "UPSERT",
          matchType: null,
          productId: null,
          listingId: null,
          plan: null,
          status: "skipped",
          messages: [...g.row.warnings, `Same SKU as row ${g.mergedInto}; merged into that row.`],
          mergedRows: [],
        });
        continue;
      }
      let fields = g.row.fields;
      let attributes = g.row.attributes;
      for (const m of g.merged) {
        fields = mergeFields(m.fields, fields);
        attributes = mergeAttributes(m.attributes, attributes);
      }
      const warnings = [...g.row.warnings];
      if (g.merged.length) {
        warnings.push(
          `SKU ${fields.sku} is in rows ${[...g.merged.map((m) => m.rowNumber), g.row.rowNumber].join(", ")}; merged — the last row wins, quantities follow the stock mode (Set: last row; Add: total).`,
        );
      }
      const mergedFields = g.merged.map((m) => m.fields);
      const planned = planRow(fields, mergedFields, ctx);
      // Register what this row will create, so later rows of the file find it.
      if (planned.plan?.outcome === "create") {
        const virtualProduct: ProductRef = planned.productId
          ? { id: planned.productId, code: "", name: fields.name ?? "", categoryId: "", brand: fields.brand ?? null, variant: null, approvalStatus: "APPROVED" }
          : { id: `new:${g.row.rowNumber}`, code: "", name: fields.name ?? "", categoryId: "", brand: fields.brand ?? null, variant: [fields.size, fields.color, fields.style].filter(Boolean).join(" / ") || null, approvalStatus: "PENDING_APPROVAL", virtual: true };
        if (!planned.productId) matcher.addProduct(virtualProduct, { gtin: fields.gtin14 ? gtinDigits(fields.gtin14) : null, barcode: fields.gtin14 ? null : (fields.barcode ?? null) });
        matcher.addListing({
          id: `new:${g.row.rowNumber}`,
          productId: virtualProduct.id,
          onlineStock: 0,
          deleted: false,
          isActive: true,
          sellerSku: fields.sku ?? null,
          onlinePricePaise: null,
          offlinePricePaise: null,
          virtual: true,
        });
      }
      staged.push({
        ...planned,
        rowNumber: g.row.rowNumber,
        rawJson,
        parsedJson: {
          fields,
          attributes,
          ...(g.merged.length ? { mergedQuantities: [...mergedFields, g.row.fields].map((f) => f.quantity ?? null) } : {}),
        },
        messages: [...warnings, ...planned.messages],
        mergedRows: g.merged.map((m) => m.rowNumber),
      });
    }

    // A parse resumed after a restart starts its rows again.
    await db.delete(productImportRows).where(eq(productImportRows.jobId, jobId));
    for (let i = 0; i < staged.length; i += ROW_INSERT_CHUNK) {
      await db.insert(productImportRows).values(staged.slice(i, i + ROW_INSERT_CHUNK).map((r) => ({ jobId, ...r })));
    }
    const counts: ImportCounts = {
      ...EMPTY_COUNTS,
      totalRows: staged.length,
      parsedRows: staged.length,
      newProducts: staged.filter((r) => r.plan?.outcome === "create").length,
      updates: staged.filter((r) => r.plan?.outcome === "update").length,
      deactivations: staged.filter((r) => r.plan?.outcome === "deactivate").length,
      skipped: staged.filter((r) => r.status === "skipped").length + parsed.emptyRows,
      withWarnings: staged.filter((r) => r.messages.length > 0).length,
    };
    await db
      .update(productImportJobs)
      .set({
        status: "preview_ready",
        sourceFormat: parsed.format,
        sheetName: parsed.sheetName,
        columns: parsed.columns.map((c) => ({ label: c.label, key: c.key, id: c.id })),
        counts,
        messages: [...parsed.messages, ...(parsed.emptyRows ? [`${parsed.emptyRows} empty row(s) skipped.`] : [])],
        lastProgressAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productImportJobs.id, jobId));
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The file could not be read.";
    if (!(error instanceof AppError)) console.error("[product-import] parse failed", jobId, error);
    await db
      .update(productImportJobs)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(productImportJobs.id, jobId));
  }
}

/**
 * A parse that never started (the response's background task was lost) or
 * stopped half-way (the server restarted) is put back to "uploaded" so it can
 * be run again. Returns true when the caller should start runParse.
 */
export async function parseNeedsRestart(jobId: string): Promise<boolean> {
  const stalledBefore = new Date(Date.now() - STALLED_AFTER_MS);
  const [reset] = await db
    .update(productImportJobs)
    .set({ status: "uploaded", updatedAt: new Date() })
    .where(and(eq(productImportJobs.id, jobId), eq(productImportJobs.status, "parsing"), lt(productImportJobs.lastProgressAt, stalledBefore)))
    .returning({ id: productImportJobs.id });
  if (reset) return true;
  const [waiting] = await db
    .select({ id: productImportJobs.id })
    .from(productImportJobs)
    .where(and(eq(productImportJobs.id, jobId), eq(productImportJobs.status, "uploaded"), lt(productImportJobs.createdAt, new Date(Date.now() - 60_000))));
  return Boolean(waiting);
}

/* ================================================================ views */

export interface ImportJobView {
  id: string;
  shopId: string;
  shopName: string;
  userId: string | null;
  userName: string | null;
  fileName: string;
  fileSizeBytes: number;
  sourceFormat: string | null;
  sheetName: string | null;
  inventoryMode: InventoryMode;
  status: ProductImportJob["status"];
  counts: ImportCounts;
  messages: string[];
  errorMessage: string | null;
  imagesStatus: ProductImportJob["imagesStatus"];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  purgedAt: string | null;
  /** An import (or parse) that has made no progress for 5 minutes: committing again resumes it. */
  stalled: boolean;
}

function toView(job: ProductImportJob & { shopName: string; userName: string | null }): ImportJobView {
  const busy = job.status === "importing" || job.status === "parsing";
  return {
    id: job.id,
    shopId: job.shopId,
    shopName: job.shopName,
    userId: job.userId,
    userName: job.userName,
    fileName: job.fileName,
    fileSizeBytes: job.fileSizeBytes,
    sourceFormat: job.sourceFormat,
    sheetName: job.sheetName,
    inventoryMode: job.inventoryMode,
    status: job.status,
    counts: { ...EMPTY_COUNTS, ...job.counts },
    messages: job.messages,
    errorMessage: job.errorMessage,
    imagesStatus: job.imagesStatus,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    purgedAt: job.purgedAt?.toISOString() ?? null,
    stalled: busy && (!job.lastProgressAt || Date.now() - job.lastProgressAt.getTime() > STALLED_AFTER_MS),
  };
}

/** Every job column except the file's bytes. */
const jobColumns = {
  id: productImportJobs.id,
  shopId: productImportJobs.shopId,
  userId: productImportJobs.userId,
  actorRole: productImportJobs.actorRole,
  fileName: productImportJobs.fileName,
  fileHash: productImportJobs.fileHash,
  fileSizeBytes: productImportJobs.fileSizeBytes,
  filePath: productImportJobs.filePath,
  sourceFormat: productImportJobs.sourceFormat,
  sheetName: productImportJobs.sheetName,
  columns: productImportJobs.columns,
  inventoryMode: productImportJobs.inventoryMode,
  status: productImportJobs.status,
  counts: productImportJobs.counts,
  messages: productImportJobs.messages,
  errorMessage: productImportJobs.errorMessage,
  imagesStatus: productImportJobs.imagesStatus,
  lastProgressAt: productImportJobs.lastProgressAt,
  startedAt: productImportJobs.startedAt,
  finishedAt: productImportJobs.finishedAt,
  purgedAt: productImportJobs.purgedAt,
  createdAt: productImportJobs.createdAt,
  updatedAt: productImportJobs.updatedAt,
};

export async function getJobView(jobId: string): Promise<ImportJobView> {
  const [row] = await db
    .select({ ...jobColumns, shopName: shops.name, userName: users.name })
    .from(productImportJobs)
    .innerJoin(shops, eq(shops.id, productImportJobs.shopId))
    .leftJoin(users, eq(users.id, productImportJobs.userId))
    .where(eq(productImportJobs.id, jobId));
  if (!row) throw notFound("Upload");
  return toView({ ...row, fileData: null } as ProductImportJob & { shopName: string; userName: string | null });
}

export async function listShopImports(shopId: string, limit = 50): Promise<ImportJobView[]> {
  const rows = await db
    .select({ ...jobColumns, shopName: shops.name, userName: users.name })
    .from(productImportJobs)
    .innerJoin(shops, eq(shops.id, productImportJobs.shopId))
    .leftJoin(users, eq(users.id, productImportJobs.userId))
    .where(eq(productImportJobs.shopId, shopId))
    .orderBy(desc(productImportJobs.createdAt))
    .limit(Math.min(limit, 200));
  return rows.map((r) => toView({ ...r, fileData: null } as ProductImportJob & { shopName: string; userName: string | null }));
}

export interface ImportRowView {
  rowNumber: number;
  sku: string | null;
  action: ImportRowAction;
  matchType: string | null;
  status: ImportRowStatus;
  messages: string[];
  plan: ImportRowPlan | null;
  productId: string | null;
  listingId: string | null;
  mergedRows: number[];
}

export const ROW_FILTERS = ["all", "warnings", "ready", "skipped", "created", "updated", "deactivated", "failed"] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export async function listJobRows(
  jobId: string,
  options: { filter?: RowFilter; page?: number; pageSize?: number } = {},
): Promise<{ rows: ImportRowView[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  const page = Math.max(options.page ?? 1, 1);
  const filter = options.filter ?? "all";
  const where = and(
    eq(productImportRows.jobId, jobId),
    filter === "warnings"
      ? sql`cardinality(${productImportRows.messages}) > 0`
      : filter === "all"
        ? undefined
        : eq(productImportRows.status, filter),
  );
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(productImportRows).where(where);
  const rows = await db
    .select({
      rowNumber: productImportRows.rowNumber,
      sku: productImportRows.sku,
      action: productImportRows.action,
      matchType: productImportRows.matchType,
      status: productImportRows.status,
      messages: productImportRows.messages,
      plan: productImportRows.plan,
      productId: productImportRows.productId,
      listingId: productImportRows.listingId,
      mergedRows: productImportRows.mergedRows,
    })
    .from(productImportRows)
    .where(where)
    .orderBy(asc(productImportRows.rowNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total, page, pageSize };
}

/* ================================================================ commit */

/** Claims a previewed job for importing (or a stalled import, to resume it). */
export async function startCommit(jobId: string, mode: InventoryMode, actor: ImportActor): Promise<void> {
  const job = await loadJobForActor(jobId, actor);
  const stalledBefore = new Date(Date.now() - STALLED_AFTER_MS);
  const [row] = await db
    .update(productImportJobs)
    .set({ status: "importing", inventoryMode: mode, lastProgressAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(productImportJobs.id, job.id),
        or(
          eq(productImportJobs.status, "preview_ready"),
          and(eq(productImportJobs.status, "importing"), lt(productImportJobs.lastProgressAt, stalledBefore)),
        ),
      ),
    )
    .returning({ id: productImportJobs.id });
  if (!row) {
    if (job.status === "importing") throw conflict("This upload is being imported now.");
    if (job.status === "parsing" || job.status === "uploaded") throw conflict("The file is still being checked. Wait for the preview.");
    throw conflict(`This upload is already ${job.status.replace("_", " ")}.`);
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_IMPORT_COMMITTED,
    entityType: "product_import_job",
    entityId: job.id,
    newValue: { shopId: job.shopId, inventoryMode: mode, resumed: job.status === "importing" },
  });
}

interface CommitContext {
  job: ProductImportJob;
  shop: { id: string; ownerId: string; name: string };
  actor: ImportActor;
  mode: InventoryMode;
  applyPrices: boolean;
  matcher: CatalogueMatcher;
  categories: Map<string, { id: string; name: string }>;
  general: { id: string; name: string };
  carried: Set<string>;
  priceProposals: ProposedChange[];
  brandIds: Map<string, string>;
}

interface RowOutcome {
  status: ImportRowStatus;
  messages: string[];
  productId: string | null;
  listingId: string | null;
  matchType: StagedRow["matchType"];
}

const UNIT_MAP: Record<string, string> = {
  pcs: "piece", pc: "piece", piece: "piece", pieces: "piece", count: "piece", nos: "piece", no: "piece", unit: "piece", units: "piece",
  kg: "kg", g: "g", gm: "g", gram: "g", grams: "g", l: "L", ltr: "L", litre: "L", liter: "L", ml: "ml", pack: "pack", packet: "pack", box: "pack",
};

function unitFor(f: ImportFields): string {
  for (const v of [f.unit, f.unitCountType]) {
    const key = v?.trim().toLowerCase();
    if (key && UNIT_MAP[key]) return UNIT_MAP[key];
  }
  return "piece";
}

async function ensureCarried(tx: DbClient, ctx: CommitContext, categoryId: string): Promise<void> {
  if (ctx.carried.has(categoryId)) return;
  await addCategoryToShop(ctx.shop.id, categoryId, ctx.actor, { reason: "bulk_upload", fillInventory: false }, tx);
  ctx.carried.add(categoryId);
}

async function nextSku(tx: DbClient, shopId: string): Promise<string> {
  const [row] = await tx.execute<{ n: string }>(sql`select nextval('product_import_sku_seq')::text as n`);
  return `GK-${shopId.slice(0, 8).toUpperCase()}-${String(row.n).padStart(5, "0")}`;
}

/** D-95: a packaged product's stock is whole; a loose one keeps up to three decimals. */
async function fractionRefused(tx: DbClient, productId: string, quantity: number, messages: string[]): Promise<boolean> {
  if (Number.isInteger(quantity)) return false;
  const [product] = await tx.select({ kind: products.kind }).from(products).where(eq(products.id, productId));
  if (product?.kind === "LOOSE") return false;
  messages.push(`Quantity ${quantity} is not a whole number for a packaged product; stock left unchanged.`);
  return true;
}

/** Sets or adds the stock of one listing, under its row lock, with a ledger row. */
async function applyStock(tx: DbClient, ctx: CommitContext, listingId: string, quantity: number, mode: InventoryMode, messages: string[]): Promise<void> {
  const [current] = await tx
    .select({ stock: shopProducts.onlineStock, productId: shopProducts.productId })
    .from(shopProducts)
    .where(eq(shopProducts.id, listingId))
    .for("update");
  if (!current) return;
  if (await fractionRefused(tx, current.productId, quantity, messages)) return;
  const target = roundStock(mode === "ADD" ? current.stock + quantity : quantity);
  if (target > MAX_STOCK) {
    messages.push(`Quantity ${quantity} would make the stock larger than allowed; stock left unchanged.`);
    return;
  }
  if (target === current.stock) return;
  // Atomic against concurrent orders: the row is locked above, and the new value is computed in SQL for Add.
  const [updated] = await tx
    .update(shopProducts)
    .set({
      onlineStock: mode === "ADD" ? sql`${shopProducts.onlineStock} + ${quantity}` : quantity,
      updatedAt: new Date(),
    })
    .where(eq(shopProducts.id, listingId))
    .returning({ stock: shopProducts.onlineStock });
  await tx.insert(inventoryMovements).values({
    shopProductId: listingId,
    channel: "ONLINE",
    deltaUnits: roundStock(updated.stock - current.stock),
    previousUnits: current.stock,
    newUnits: updated.stock,
    reason: `Bulk upload (${mode === "ADD" ? "add" : "set"})`,
    source: "bulk_upload",
    importJobId: ctx.job.id,
    createdBy: ctx.actor.id,
  });
  await evaluateStockAlerts(listingId, tx);
}

/** Whether the file's selling price may be used: more than 0, not above this shop's MRP, not above an enforced catalogue MRP. */
async function priceAllowed(tx: DbClient, productId: string, price: number, shopMrp: number | null, messages: string[]): Promise<boolean> {
  if (price <= 0) {
    messages.push("Selling price must be more than 0; price not changed.");
    return false;
  }
  if (shopMrp != null && price > shopMrp) {
    messages.push(`Selling price ₹${(price / 100).toFixed(2)} is above the MRP ₹${(shopMrp / 100).toFixed(2)}; price not changed.`);
    return false;
  }
  const check = await checkPriceAgainstMrp(productId, { online: price, offline: price }, tx);
  if (check.enforced && check.violations.length > 0) {
    messages.push(`Selling price ₹${(price / 100).toFixed(2)} is above the catalogue MRP ₹${(check.violations[0].mrpPaise / 100).toFixed(2)}; price not changed.`);
    return false;
  }
  return true;
}

function proposePrice(ctx: CommitContext, listingId: string, price: number, messages: string[]): void {
  ctx.priceProposals.push({ shopProductId: listingId, priceType: "ONLINE", proposedPricePaise: price });
  ctx.priceProposals.push({ shopProductId: listingId, priceType: "OFFLINE", proposedPricePaise: price });
  messages.push("Price sent to the shop owner for approval (it goes live when they approve).");
}

/** The shop's price for an existing listing, when the file gives one: applied (owner/admin) or proposed (operator). */
async function applyPrice(tx: DbClient, ctx: CommitContext, listing: ListingRef, f: ImportFields, shopMrp: number | null, messages: string[]): Promise<void> {
  const price = f.pricePaise;
  if (price == null) return;
  if (!(await priceAllowed(tx, listing.productId, price, shopMrp, messages))) return;
  const [current] = await tx
    .select({ online: shopProducts.onlinePricePaise, offline: shopProducts.offlinePricePaise })
    .from(shopProducts)
    .where(eq(shopProducts.id, listing.id));
  if (current?.online === price && current?.offline === price) return;
  if (!ctx.applyPrices) {
    proposePrice(ctx, listing.id, price, messages);
    return;
  }
  const unpriced = current?.online == null && current?.offline == null;
  await updateShopProduct(
    listing.id,
    {
      onlinePricePaise: price,
      offlinePricePaise: price,
      ...(unpriced ? { onlineSaleEnabled: true, offlineSaleEnabled: true } : {}),
    },
    ctx.actor as { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
    tx,
  );
}

function deepMergeAttributes(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    const prev = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = { ...(prev as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else if (v != null) out[k] = v;
  }
  return out;
}

/** Writes shop_listing_details: only cells with a value change anything. Returns the listing's MRP for this shop. */
async function upsertDetails(
  tx: DbClient,
  ctx: CommitContext,
  listing: ListingRef,
  f: ImportFields,
  attributes: Record<string, Record<string, unknown>>,
  isNew: boolean,
  messages: string[],
  /** The listing was inserted by this row: it has no details yet (saves a read). */
  freshListing = false,
): Promise<number | null> {
  const [existing] = freshListing ? [] : await tx.select().from(shopListingDetails).where(eq(shopListingDetails.shopProductId, listing.id));
  let sku: string | null | undefined;
  if (f.sku) {
    const owner = ctx.matcher.listingBySku(f.sku);
    if (owner && owner.id !== listing.id && !owner.virtual) {
      messages.push(`SKU ${f.sku} is already used by another product in this shop; SKU not changed.`);
    } else if (existing?.sellerSku) {
      if (existing.sellerSku.toLowerCase() !== f.sku.toLowerCase()) {
        messages.push(`This product already has SKU ${existing.sellerSku} in your shop; it was kept.`);
      }
    } else sku = f.sku;
  } else if (!existing?.sellerSku) {
    sku = await nextSku(tx, ctx.shop.id);
    messages.push(`SKU ${sku} was generated.`);
  }
  const values = {
    ...(sku !== undefined ? { sellerSku: sku } : {}),
    ...(f.mrpPaise != null ? { mrpPaise: f.mrpPaise } : {}),
    ...(f.salePricePaise != null ? { salePricePaise: f.salePricePaise } : {}),
    ...(f.saleStart ? { saleStartsOn: f.saleStart } : {}),
    ...(f.saleEnd ? { saleEndsOn: f.saleEnd } : {}),
    ...(f.handlingDays != null ? { handlingDays: f.handlingDays } : {}),
    ...(f.restockDate ? { restockOn: f.restockDate } : {}),
    ...(f.alwaysAvailable != null ? { alwaysAvailable: f.alwaysAvailable } : {}),
    ...(f.condition ? { itemCondition: f.condition } : isNew && !existing?.itemCondition ? { itemCondition: "New" } : {}),
    ...(f.conditionNote ? { conditionNote: f.conditionNote } : {}),
    ...(f.giftWrap != null ? { giftWrap: f.giftWrap } : {}),
    ...(f.giftMessage != null ? { giftMessage: f.giftMessage } : {}),
  };
  const extra: Record<string, unknown> = {};
  if (f.b2b) extra.b2b = f.b2b;
  if (f.compliance) extra.compliance = f.compliance;
  const merged = deepMergeAttributes((existing?.attributes as Record<string, unknown>) ?? {}, { ...attributes, ...extra });
  if (existing) {
    await tx
      .update(shopListingDetails)
      .set({ ...values, attributes: merged, lastImportJobId: ctx.job.id, updatedBy: ctx.actor.id, updatedAt: new Date() })
      .where(eq(shopListingDetails.shopProductId, listing.id));
  } else {
    await tx.insert(shopListingDetails).values({
      shopProductId: listing.id,
      shopId: ctx.shop.id,
      ...values,
      attributes: merged,
      lastImportJobId: ctx.job.id,
      updatedBy: ctx.actor.id,
    });
  }
  if (sku) ctx.matcher.setSku(listing, sku);
  return f.mrpPaise ?? existing?.mrpPaise ?? null;
}

async function brandIdFor(tx: DbClient, ctx: CommitContext, name: string | undefined): Promise<string | null> {
  if (!name) return null;
  const key = matchKey(name);
  if (ctx.brandIds.has(key)) return ctx.brandIds.get(key) || null;
  const [found] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(and(sql`lower(regexp_replace(${brands.name}, '[^a-zA-Z0-9]+', ' ', 'g')) = ${key}`, isNull(brands.deletedAt)))
    .limit(1);
  ctx.brandIds.set(key, found?.id ?? "");
  return found?.id ?? null;
}

async function createProduct(tx: DbClient, ctx: CommitContext, f: ImportFields, attributes: Record<string, Record<string, unknown>>, messages: string[]): Promise<ProductRef> {
  const category = resolveCategory(f, ctx);
  const name = f.name ?? `Unnamed product ${f.sku ?? f.barcode ?? ""}`.trim();
  const brandId = await brandIdFor(tx, ctx, f.brand);
  const variant = [f.size, f.color, f.style].filter(Boolean).join(" / ") || null;
  const gtin = f.gtin14 ? gtinDigits(f.gtin14) : null;
  const [product] = await tx
    .insert(products)
    .values({
      categoryId: category.id,
      name,
      slug: uniqueSlug(name),
      description: f.description ?? f.highlight ?? null,
      specifications: f.bullets?.length ? f.bullets.map((b) => `• ${b}`).join("\n") : null,
      brandId,
      kind: "PACKAGED",
      gtin,
      barcode: gtin ? null : (f.barcode ?? null),
      variant,
      hsnCode: f.hsnCode ?? null,
      gstRateBp: f.gstRateBp ?? null,
      manufacturerName: f.manufacturer ?? null,
      countryOfOrigin: f.countryOfOrigin ?? null,
      unit: unitFor(f),
      unitSizeMilli: 1000,
      subscribable: false,
      // Every product an upload creates waits for the catalogue team (the brief's "Pending"),
      // whoever uploaded; the shop sells it at once through its own listing.
      approvalStatus: "PENDING_APPROVAL",
      createdBy: ctx.actor.id,
    })
    .returning();
  await tx.insert(productAttributes).values({
    productId: product.id,
    attributes: {
      ...attributes,
      ...(f.brand && !brandId ? { _brand: f.brand } : {}),
      ...(f.productType ? { _productType: f.productType } : {}),
      ...(f.compliance ? { _compliance: f.compliance } : {}),
      _dimensions: {
        itemWeightG: f.itemWeightG ?? null,
        itemLengthCm: f.itemLengthCm ?? null,
        itemWidthCm: f.itemWidthCm ?? null,
        itemHeightCm: f.itemHeightCm ?? null,
        packageLengthCm: f.packageLengthCm ?? null,
        packageWidthCm: f.packageWidthCm ?? null,
        packageHeightCm: f.packageHeightCm ?? null,
        packageWeightG: f.packageWeightG ?? null,
      },
    },
    sourceImportJobId: ctx.job.id,
  });
  await recordAudit(
    {
      actorId: ctx.actor.id,
      actorRole: ctx.actor.role,
      action: AUDIT_ACTIONS.GLOBAL_PRODUCT_CREATED,
      entityType: "product",
      entityId: product.id,
      newValue: { name: product.name, categoryId: product.categoryId, approvalStatus: product.approvalStatus, shopId: ctx.shop.id, via: "bulk_upload", importJobId: ctx.job.id },
    },
    tx,
  );
  if (f.brand && !brandId) messages.push(`Brand "${f.brand}" is not in the GoKesari brand list yet; kept with the product's details.`);
  const ref: ProductRef = { id: product.id, code: product.code, name: product.name, categoryId: product.categoryId, brand: f.brand ?? null, variant, approvalStatus: product.approvalStatus };
  ctx.matcher.addProduct(ref, { gtin, barcode: gtin ? null : (f.barcode ?? null) });
  return ref;
}

interface InitialListing {
  /** The shop's price, already checked (applied straight away: owner or admin). */
  pricePaise: number | null;
  /** Stock in Set mode or Add mode alike (a new listing starts from 0). */
  stock: number | null;
  maxOrderQty: number | null;
}

async function createOrRestoreListing(
  tx: DbClient,
  ctx: CommitContext,
  product: ProductRef,
  existing: ListingRef | null,
  initial: InitialListing = { pricePaise: null, stock: null, maxOrderQty: null },
): Promise<ListingRef> {
  await ensureCarried(tx, ctx, product.categoryId);
  if (existing && existing.deleted) {
    await tx
      .update(shopProducts)
      .set({ deletedAt: null, isActive: true, isAvailable: true, updatedAt: new Date() })
      .where(eq(shopProducts.id, existing.id));
    existing.deleted = false;
    existing.isActive = true;
    return existing;
  }
  const stock = initial.stock != null && initial.stock <= MAX_STOCK ? initial.stock : 0;
  const priced = initial.pricePaise != null;
  const [created] = await tx
    .insert(shopProducts)
    .values({
      shopId: ctx.shop.id,
      productId: product.id,
      isActive: true,
      isAvailable: true,
      onlinePricePaise: initial.pricePaise,
      offlinePricePaise: initial.pricePaise,
      // A listing goes on sale with its first price, as on the inventory page.
      onlineSaleEnabled: priced,
      offlineSaleEnabled: priced,
      onlineStock: stock,
      offlineStock: 0,
      ...(initial.maxOrderQty != null ? { maximumOrderQuantity: initial.maxOrderQty } : {}),
    })
    .returning();
  if (stock > 0) {
    await tx.insert(inventoryMovements).values({
      shopProductId: created.id,
      channel: "ONLINE",
      deltaUnits: stock,
      previousUnits: 0,
      newUnits: stock,
      reason: `Bulk upload (${ctx.mode === "ADD" ? "add" : "set"})`,
      source: "bulk_upload",
      importJobId: ctx.job.id,
      createdBy: ctx.actor.id,
    });
  }
  await evaluateStockAlerts(created.id, tx);
  await recordAudit(
    {
      actorId: ctx.actor.id,
      actorRole: ctx.actor.role,
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      entityType: "shop_product",
      entityId: created.id,
      newValue: {
        productId: product.id,
        shopId: ctx.shop.id,
        onlinePricePaise: created.onlinePricePaise,
        offlinePricePaise: created.offlinePricePaise,
        onlineSaleEnabled: created.onlineSaleEnabled,
        onlineStock: created.onlineStock,
        via: "bulk_upload",
        importJobId: ctx.job.id,
      },
    },
    tx,
  );
  const ref: ListingRef = {
    id: created.id,
    productId: product.id,
    onlineStock: created.onlineStock,
    deleted: false,
    isActive: true,
    sellerSku: null,
    onlinePricePaise: created.onlinePricePaise,
    offlinePricePaise: created.offlinePricePaise,
  };
  ctx.matcher.addListing(ref);
  return ref;
}

async function categoryOf(tx: DbClient, productId: string): Promise<string> {
  const [p] = await tx.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, productId));
  return p.categoryId;
}

/** The commit of one row, inside its own savepoint. */
async function commitRow(tx: DbClient, ctx: CommitContext, row: ProductImportRow): Promise<RowOutcome> {
  const parsed = row.parsedJson as { fields: ImportFields; attributes: Record<string, Record<string, unknown>>; mergedQuantities?: (number | null)[] };
  const f = parsed.fields;
  const messages: string[] = [];
  const action = row.action;
  const res = ctx.matcher.resolve(f);
  let listing = res.listing;
  let matchType: StagedRow["matchType"] = res.matchType;
  if (res.matchType === "NAME" && res.product) messages.push(`Matched by name and brand to catalogue product ${res.product.code}.`);
  if (res.matchType === "BARCODE" && res.product) messages.push(`Matched by barcode to catalogue product ${res.product.code}.`);

  // Quantity for this row in this mode (merged rows: Set = last, Add = total).
  const qs = (parsed.mergedQuantities ?? [f.quantity ?? null]).filter((q): q is number => q != null);
  const quantity = qs.length === 0 ? null : ctx.mode === "ADD" ? qs.reduce((a, b) => a + b, 0) : qs[qs.length - 1];

  if (action === "DELETE") {
    if (!listing || listing.deleted) {
      messages.push("Delete: no matching product in this shop; row skipped.");
      return { status: "skipped", messages, productId: res.product?.id ?? null, listingId: null, matchType: "NONE" };
    }
    await updateShopProduct(listing.id, { isActive: false, isAvailable: false }, ctx.actor as { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" }, tx);
    listing.isActive = false;
    await applyStock(tx, ctx, listing.id, 0, "SET", messages);
    return { status: "deactivated", messages, productId: listing.productId, listingId: listing.id, matchType };
  }

  if (action === "EDIT" && (!listing || listing.deleted)) {
    messages.push("Edit (partial update): no matching product in this shop; row skipped.");
    return { status: "skipped", messages, productId: res.product?.id ?? null, listingId: null, matchType: "NONE" };
  }

  let status: ImportRowStatus = "updated";
  if (!listing) {
    // A brand-new listing: price, stock and order limit go in with the insert (fewer round trips).
    let product = res.product;
    if (!product) {
      product = await createProduct(tx, ctx, f, parsed.attributes, messages);
      matchType = "NEW";
    }
    const price = f.pricePaise != null && (await priceAllowed(tx, product.id, f.pricePaise, f.mrpPaise ?? null, messages)) ? f.pricePaise : null;
    if (quantity != null && quantity > MAX_STOCK) messages.push(`Quantity ${quantity} is larger than allowed; stock left at 0.`);
    const stock = quantity != null && (await fractionRefused(tx, product.id, quantity, messages)) ? null : quantity;
    listing = await createOrRestoreListing(tx, ctx, product, null, {
      pricePaise: ctx.applyPrices ? price : null,
      stock,
      maxOrderQty: f.maxOrderQty ?? null,
    });
    if (price != null && !ctx.applyPrices) proposePrice(ctx, listing.id, price, messages);
    await upsertDetails(tx, ctx, listing, f, parsed.attributes, true, messages, true);
    if (stock == null && quantity == null && f.quantityInvalid == null) messages.push("No quantity: the product is not orderable until stock is set.");
    return { status: "created", messages, productId: listing.productId, listingId: listing.id, matchType };
  }
  if (listing.deleted) {
    listing = await createOrRestoreListing(tx, ctx, res.product ?? { id: listing.productId, code: "", name: "", categoryId: await categoryOf(tx, listing.productId), brand: null, variant: null, approvalStatus: "" }, listing);
    status = "created";
  } else if (action === "UPSERT" && !listing.isActive) {
    // "Create or Replace" on a listing an earlier Delete deactivated puts it back on sale.
    await updateShopProduct(listing.id, { isActive: true, isAvailable: true }, ctx.actor as { id: string; role: "SHOP_OWNER" | "OPERATOR" | "ADMIN" }, tx);
    listing.isActive = true;
    messages.push("This product was deactivated; it is active again.");
  }

  const shopMrp = await upsertDetails(tx, ctx, listing, f, parsed.attributes, status === "created", messages);
  await applyPrice(tx, ctx, listing, f, shopMrp, messages);

  if (f.maxOrderQty != null) {
    const [sp] = await tx.select({ min: shopProducts.minimumOrderQuantity }).from(shopProducts).where(eq(shopProducts.id, listing.id));
    if (sp && f.maxOrderQty >= sp.min) {
      await tx.update(shopProducts).set({ maximumOrderQuantity: f.maxOrderQty, updatedAt: new Date() }).where(eq(shopProducts.id, listing.id));
    } else messages.push(`Max order quantity ${f.maxOrderQty} is below the minimum order quantity; not changed.`);
  }

  if (quantity != null) await applyStock(tx, ctx, listing.id, quantity, ctx.mode, messages);
  else if (status === "created" && f.quantityInvalid == null) messages.push("No quantity: the product is not orderable until stock is set.");

  return { status, messages, productId: listing.productId, listingId: listing.id, matchType };
}

/** Rows that will still be processed: preview warnings plus what the commit adds. */
function uniqueMessages(previous: string[], added: string[]): string[] {
  // Preview-only notes about what *will* happen are replaced by what did happen.
  const keep = previous.filter((m) => !/will be|No quantity:|No SKU:|^New product:|^Delete:|^Matched by (name|barcode)/.test(m));
  return [...new Set([...keep, ...added])];
}

async function countRows(jobId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: productImportRows.status, n: sql<number>`count(*)::int`, warned: sql<number>`count(*) filter (where cardinality(${productImportRows.messages}) > 0)::int` })
    .from(productImportRows)
    .where(eq(productImportRows.jobId, jobId))
    .groupBy(productImportRows.status);
  const out: Record<string, number> = { warned: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.warned += r.warned;
  }
  return out;
}

export interface CommitOptions {
  /** Image downloader (tests pass a stub). */
  fetcher?: ImageFetcher;
  /** Skip the image phase (tests that do not need it). */
  skipImages?: boolean;
}

/**
 * Writes a claimed job's rows. Rows already done are skipped, so a resumed
 * import continues where it stopped. Never throws for a row; a batch that
 * cannot be written at all marks its rows failed.
 */
export async function runCommit(jobId: string, actor: ImportActor, options: CommitOptions = {}): Promise<ImportJobView> {
  const [job] = await db.select().from(productImportJobs).where(eq(productImportJobs.id, jobId));
  if (!job) throw notFound("Upload");
  if (job.status !== "importing") throw conflict("This upload is not being imported.");
  const access = await assertImportAccess(job.shopId, actor);
  const limits = await getImportLimits();
  const { categories, general } = await loadCategories(db);
  const carriedRows = await db.execute<{ category_id: string }>(sql`select category_id from shop_product_categories where shop_id = ${job.shopId}`);
  const ctxBase = {
    job,
    shop: { id: job.shopId, ownerId: access.ownerId, name: access.shopName },
    actor,
    mode: job.inventoryMode,
    applyPrices: appliesImmediately(actor, access.ownerId),
    categories,
    general,
    carried: new Set(carriedRows.map((r) => r.category_id)),
    priceProposals: [] as ProposedChange[],
    brandIds: new Map<string, string>(),
  };

  let processed = 0;
  for (;;) {
    const batch = await db
      .select()
      .from(productImportRows)
      .where(and(eq(productImportRows.jobId, jobId), eq(productImportRows.status, "ready")))
      .orderBy(asc(productImportRows.rowNumber))
      .limit(limits.batchSize);
    if (batch.length === 0) break;
    // Kept only once the batch commits: on the seller / customer split a batch can be re-run, and
    // a rolled-back attempt's proposals would name listings that no longer exist.
    let batchProposals: ProposedChange[] = [];
    try {
      await db.transaction(async (tx) => {
        const matcher = await CatalogueMatcher.load(job.shopId, batch.map((r) => (r.parsedJson as { fields: ImportFields }).fields), tx);
        batchProposals = [];
        const ctx: CommitContext = { ...ctxBase, matcher, priceProposals: batchProposals };
        for (const row of batch) {
          let outcome: RowOutcome;
          try {
            outcome = await tx.transaction((sp) => commitRow(sp, ctx, row));
          } catch (error) {
            // Seller / customer split: a concurrent change to the same listing ends in a serialization
            // failure (never on one database); the whole batch is retried by db.transaction, not failed row by row.
            if (isSerializationFailure(error)) throw error;
            const reason = error instanceof AppError ? error.message : "Could not be saved.";
            if (!(error instanceof AppError)) console.error("[product-import] row failed", jobId, row.rowNumber, error);
            outcome = { status: "failed", messages: [`Failed: ${reason}`], productId: row.productId, listingId: row.listingId, matchType: row.matchType };
          }
          await tx
            .update(productImportRows)
            .set({
              status: outcome.status,
              messages: uniqueMessages(row.messages, outcome.messages),
              productId: outcome.productId,
              listingId: outcome.listingId,
              matchType: outcome.matchType,
              updatedAt: new Date(),
            })
            .where(eq(productImportRows.id, row.id));
        }
      });
      ctxBase.priceProposals.push(...batchProposals);
    } catch (error) {
      console.error("[product-import] batch failed", jobId, error);
      await db
        .update(productImportRows)
        .set({ status: "failed", messages: sql`array_append(${productImportRows.messages}, ${"Failed: this batch could not be saved; try importing the row again."})`, updatedAt: new Date() })
        .where(inArray(productImportRows.id, batch.map((r) => r.id)));
    }
    processed += batch.length;
    await db
      .update(productImportJobs)
      .set({
        counts: sql`${productImportJobs.counts} || jsonb_build_object('processedRows', ${processed}::int)`,
        lastProgressAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productImportJobs.id, jobId));
  }

  const jobMessages: string[] = [];
  if (ctxBase.priceProposals.length > 0) {
    try {
      await submitPriceRequests(
        { shopId: job.shopId, changes: ctxBase.priceProposals, note: `Bulk upload: ${job.fileName}` },
        actor,
      );
      jobMessages.push(`${ctxBase.priceProposals.length / 2} price change(s) were sent to the shop owner for approval.`);
    } catch (error) {
      console.error("[product-import] price proposals failed", jobId, error);
      jobMessages.push("The price changes could not be sent to the shop owner for approval; set them from Price updates.");
    }
  }

  const tally = await countRows(jobId);
  const imagesQueued = options.skipImages ? 0 : await countQueuedImages(jobId, limits.maxImagesPerRow);
  const counts: ImportCounts = {
    ...EMPTY_COUNTS,
    ...job.counts,
    processedRows: processed + (job.counts.processedRows ?? 0),
    created: tally.created ?? 0,
    updated: tally.updated ?? 0,
    deactivated: tally.deactivated ?? 0,
    failed: tally.failed ?? 0,
    withWarnings: tally.warned ?? 0,
    imagesQueued,
  };
  await db.transaction(async (tx) => {
    await tx
      .update(productImportJobs)
      .set({
        status: "completed",
        counts,
        messages: [...job.messages, ...jobMessages],
        imagesStatus: imagesQueued > 0 ? "queued" : "none",
        finishedAt: new Date(),
        lastProgressAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productImportJobs.id, jobId));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_IMPORT_COMPLETED,
        entityType: "product_import_job",
        entityId: jobId,
        newValue: { shopId: job.shopId, inventoryMode: job.inventoryMode, counts },
      },
      tx,
    );
    // Real-time, event-driven: written in this transaction, sent right after commit (no cron).
    await emitEvent(
      {
        type: "shop.product_import_finished",
        subjectId: jobId,
        actor: { id: actor.id, role: actor.role },
        payload: {
          jobId,
          shopId: job.shopId,
          shopName: access.shopName,
          ownerId: access.ownerId,
          actorId: actor.id,
          fileName: job.fileName,
          created: counts.created,
          updated: counts.updated,
          deactivated: counts.deactivated,
          failed: counts.failed,
          status: "completed",
        },
        idempotencyKey: `product-import:${jobId}:finished`,
      },
      tx,
    );
  });

  if (imagesQueued > 0) await runImageImport(jobId, actor, { fetcher: options.fetcher ?? fetchImage });
  return getJobView(jobId);
}

/* ================================================================ images */

function imageUrlsOf(f: ImportFields, max: number): string[] {
  return [...new Set([f.mainImage, ...(f.otherImages ?? [])].filter((u): u is string => Boolean(u)))].slice(0, max);
}

async function countQueuedImages(jobId: string, maxPerRow: number): Promise<number> {
  const rows = await db
    .select({ parsed: productImportRows.parsedJson })
    .from(productImportRows)
    .where(and(eq(productImportRows.jobId, jobId), inArray(productImportRows.status, ["created", "updated"])));
  return rows.reduce((n, r) => n + imageUrlsOf((r.parsed as { fields: ImportFields }).fields ?? {}, maxPerRow).length, 0);
}

/**
 * Downloads the rows' image URLs (each distinct URL once) and adds them as
 * the listing's photos — only to a listing with no photos of its own yet, so
 * importing a file again never duplicates photos. A failed image is a warning
 * on its row; the product stays.
 */
export async function runImageImport(jobId: string, actor: ImportActor, options: { fetcher: ImageFetcher }): Promise<void> {
  const [claimed] = await db
    .update(productImportJobs)
    .set({ imagesStatus: "running", updatedAt: new Date() })
    .where(and(eq(productImportJobs.id, jobId), eq(productImportJobs.imagesStatus, "queued")))
    .returning();
  if (!claimed) return;
  const limits = await getImportLimits();
  const media = await getRule("shopProductMedia");
  const access = await assertImportAccess(claimed.shopId, actor);
  const catalogueActor = { id: actor.id, role: actor.role, via: access.isOwner ? ("OWNER" as const) : ("SUPPORT" as const) };
  const moderationStatus = await initialStatus(catalogueActor);
  const downloads = new Map<string, Promise<Buffer>>();
  const download = (url: string) => {
    let p = downloads.get(url);
    if (!p) {
      p = options.fetcher(url, { maxBytes: limits.imageMaxBytes, timeoutMs: limits.imageTimeoutMs }).then((r) => r.bytes);
      p.catch(() => undefined);
      downloads.set(url, p);
    }
    return p;
  };

  const rows = await db
    .select({
      id: productImportRows.id,
      listingId: productImportRows.listingId,
      productId: productImportRows.productId,
      parsed: productImportRows.parsedJson,
      messages: productImportRows.messages,
    })
    .from(productImportRows)
    .where(and(eq(productImportRows.jobId, jobId), inArray(productImportRows.status, ["created", "updated"])))
    .orderBy(asc(productImportRows.rowNumber));
  let saved = 0;
  let failed = 0;
  for (const row of rows) {
    const urls = imageUrlsOf((row.parsed as { fields: ImportFields }).fields ?? {}, limits.maxImagesPerRow);
    if (urls.length === 0 || !row.listingId || !row.productId) continue;
    const notes: string[] = [];
    const own = await listImages(row.productId, row.listingId);
    if (own.length > 0) {
      notes.push("Images not added: this product already has photos in your shop.");
    } else {
      for (const url of urls.slice(0, media.maxPhotos)) {
        try {
          const bytes = await download(url);
          const photo = await processProductPhoto(bytes, { ...media, maxUploadBytes: Math.min(media.maxUploadBytes, limits.imageMaxBytes) });
          const blobs = await storePhotoBlobs(photo);
          try {
            await db.transaction(async (tx) => {
              const listing = await lockListing(tx, row.listingId!);
              await attachProcessedPhoto(tx, listing, photo, blobs, catalogueActor, moderationStatus, media.maxPhotos, { importJobId: jobId, sourceUrl: url });
            });
            saved += 1;
          } catch (error) {
            await discardPhotoBlobs(blobs);
            throw error;
          }
        } catch (error) {
          failed += 1;
          const reason = error instanceof ImageFetchError || error instanceof AppError ? error.message : "could not be saved";
          notes.push(`Image ${url}: ${reason}.`);
        }
      }
    }
    if (notes.length) {
      await db
        .update(productImportRows)
        .set({ messages: [...row.messages, ...notes], updatedAt: new Date() })
        .where(eq(productImportRows.id, row.id));
    }
  }
  await db
    .update(productImportJobs)
    .set({
      imagesStatus: "done",
      counts: sql`${productImportJobs.counts} || jsonb_build_object('imagesSaved', ${saved}::int, 'imagesFailed', ${failed}::int)`,
      updatedAt: new Date(),
    })
    .where(eq(productImportJobs.id, jobId));
}

/* ================================================================ cancel, report, history */

export async function cancelJob(jobId: string, actor: ImportActor): Promise<ImportJobView> {
  const job = await loadJobForActor(jobId, actor);
  const [row] = await db
    .update(productImportJobs)
    .set({ status: "cancelled", fileData: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(productImportJobs.id, job.id), inArray(productImportJobs.status, ["uploaded", "parsing", "preview_ready", "failed"])))
    .returning({ id: productImportJobs.id });
  if (!row) throw conflict(job.status === "importing" ? "This upload is being imported and cannot be cancelled now." : `This upload is already ${job.status.replace("_", " ")}.`);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_IMPORT_CANCELLED,
    entityType: "product_import_job",
    entityId: job.id,
    previousValue: { status: job.status },
    newValue: { status: "cancelled" },
  });
  return getJobView(job.id);
}

export async function buildReport(jobId: string, format: "csv" | "xlsx", actor: ImportActor): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
  const job = await loadJobForActor(jobId, actor);
  const rows = await db
    .select({ rowNumber: productImportRows.rowNumber, raw: productImportRows.rawJson, status: productImportRows.status, messages: productImportRows.messages })
    .from(productImportRows)
    .where(eq(productImportRows.jobId, jobId))
    .orderBy(asc(productImportRows.rowNumber));
  const columns = (job.columns as { label: string; key: string | null; id?: string }[]).map((c) => ({ label: c.label, id: c.id ?? c.key ?? c.label }));
  const input = { columns, rows: rows.map((r) => ({ ...r, raw: r.raw as Record<string, unknown> })) };
  const base = job.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_").slice(0, 80) || "upload";
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_IMPORT_REPORT_DOWNLOADED,
    entityType: "product_import_job",
    entityId: job.id,
    newValue: { format },
  });
  if (format === "csv") return { fileName: `${base}_result.csv`, contentType: "text/csv; charset=utf-8", bytes: reportCsv(input) };
  return {
    fileName: `${base}_result.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: await reportXlsx(input),
  };
}

export async function simpleTemplate(): Promise<{ fileName: string; bytes: Buffer }> {
  return { fileName: TEMPLATE_FILE_NAME, bytes: await buildSimpleTemplate() };
}

/**
 * Retention: uploaded files and staged rows older than `retentionDays` are
 * deleted; the job's summary stays in the history. Called by the daily
 * seller sweep (api/cron/seller-verification).
 */
export async function purgeOldProductImports(now = new Date()): Promise<{ jobs: number }> {
  const { retentionDays } = await getImportLimits();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const old = await db
    .select({ id: productImportJobs.id })
    .from(productImportJobs)
    .where(and(lt(productImportJobs.createdAt, cutoff), isNull(productImportJobs.purgedAt), inArray(productImportJobs.status, ["completed", "failed", "cancelled", "preview_ready"])));
  if (old.length === 0) return { jobs: 0 };
  const ids = old.map((o) => o.id);
  await db.transaction(async (tx) => {
    await tx.delete(productImportRows).where(inArray(productImportRows.jobId, ids));
    await tx.update(productImportJobs).set({ fileData: null, purgedAt: now, updatedAt: now }).where(inArray(productImportJobs.id, ids));
  });
  return { jobs: ids.length };
}

/** Shops an operator/admin may pick from on the admin Bulk Upload screen. */
export async function searchShopsForImport(query: string, limit = 20): Promise<{ id: string; name: string; city: string; status: string }[]> {
  const term = query.trim();
  return db
    .select({ id: shops.id, name: shops.name, city: shops.city, status: shops.status })
    .from(shops)
    .where(and(isNull(shops.deletedAt), term ? sql`(${shops.name} ilike ${`%${term}%`} or ${shops.city} ilike ${`%${term}%`})` : undefined))
    .orderBy(asc(shops.name))
    .limit(Math.min(limit, 50));
}

export { plannedStock };
