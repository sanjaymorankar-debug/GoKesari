/**
 * Excel goods/price upload (requirements §2.3, §6, §8, §9, §21, §24).
 *
 * The flow is deliberately two-phase:
 *
 *   validateUpload()  parse → validate every row → persist the verdict. Writes
 *                     NOTHING to shop_products. Returns a preview.
 *   applyUpload()     turn the VALID rows into price changes, routed through
 *                     the normal approval workflow.
 *
 * That split is what satisfies §21's "never partially corrupt live data": a
 * malformed sheet fails at phase one, where the only thing written is a record
 * of why it failed.
 *
 * Prices in the sheet are RUPEES (that is what a shopkeeper types); everything
 * past the parser is integer paise.
 */
import ExcelJS from "exceljs";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  excelUploadItems,
  excelUploads,
  productCategories,
  products,
  shopProducts,
  shops,
  type ExcelRowStatus,
  type ExcelUpload,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { appliesImmediately, submitPriceRequests } from "./price-requests";
import { createShopProduct, createProductForShop, findSimilarProducts, updateShopProduct } from "./catalogue";
import { ensureGeneralCategory, shopCarriesProductCategory } from "./product-categories";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

/** §21 — bound the upload well below anything that could exhaust memory. */
/** Code defaults; the live limits are rule `uploads` (spreadsheetMaxBytes, spreadsheetMaxRows). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_ROWS = 5_000;

/** Live spreadsheet limits (rule `uploads`). */
export async function getSpreadsheetLimits(): Promise<{ maxBytes: number; maxRows: number }> {
  const rule = await getRule("uploads");
  return { maxBytes: rule.spreadsheetMaxBytes, maxRows: rule.spreadsheetMaxRows };
}

const ACCEPTED_EXTENSIONS = [".xlsx", ".xlsm"];

/** Columns the parser understands. Matching is case- and space-insensitive. */
const COLUMN_ALIASES: Record<string, string> = {
  "product id": "productCode",
  "product code": "productCode",
  code: "productCode",
  sku: "productCode",
  "product name": "productName",
  product: "productName",
  name: "productName",
  unit: "unit",
  price: "price",
  "online price": "onlinePrice",
  "offline price": "offlinePrice",
  category: "category",
  "sub category": "subCategory",
  subcategory: "subCategory",
  "sub-category": "subCategory",
  description: "description",
  specifications: "specifications",
  specification: "specifications",
  stock: "stock",
  active: "active",
};

export const TEMPLATE_COLUMNS = [
  "Product ID",
  "Product Name",
  "Category",
  "Unit",
  "Price",
  "Online Price",
  "Offline Price",
] as const;

/** GOODS uploads additionally accept these — a new product needs a category. */
export const GOODS_TEMPLATE_COLUMNS = [
  "Product ID",
  "Product Name",
  "Description",
  "Specifications",
  "Category",
  "Sub Category",
  "Unit",
  "Price",
  "Online Price",
  "Offline Price",
] as const;

function normaliseHeader(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return COLUMN_ALIASES[key] ?? null;
}

/**
 * §21 — neutralise spreadsheet formula injection.
 *
 * A cell beginning =, +, - or @ is executable when the sheet is reopened in
 * Excel. We never evaluate formulas, but these values can be echoed back into a
 * generated sheet, so they are defanged at the boundary.
 */
export function sanitiseCell(value: unknown): string {
  if (value == null) return "";
  const text = String(
    typeof value === "object" && "text" in (value as Record<string, unknown>)
      ? (value as { text: unknown }).text
      : value,
  ).trim();
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** Rupee string/number → integer paise. Returns null when unparseable. */
export function parseRupeesToPaise(raw: unknown): number | null {
  if (raw == null || raw === "") return null;

  const text = String(raw)
    .replace(/[₹,\s]/g, "")
    .replace(/^'/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const paise = Math.round(Number(text) * 100);
  if (!Number.isFinite(paise) || paise < 0) return null;
  return paise;
}

export interface ParsedRow {
  rowNumber: number;
  productCode: string;
  productName: string;
  unit: string;
  pricePaise: number | null;
  /** GOODS uploads only. */
  category: string;
  subCategory: string;
  description: string;
  specifications: string;
  raw: Record<string, unknown>;
}

export interface PreviewRow extends ParsedRow {
  status: ExcelRowStatus;
  errorMessage: string | null;
  matchedShopProductId: string | null;
  /** GOODS uploads only: matched a central-catalogue product this shop lacks. */
  matchedProductId: string | null;
  /** GOODS uploads only: name looks similar to an existing product (§ "flag for review"). */
  possibleDuplicateProductId: string | null;
  possibleDuplicateName: string | null;
  previousPricePaise: number | null;
  differencePaise: number | null;
}

export interface UploadPreview {
  uploadId: string;
  shopId: string;
  fileName: string;
  rows: PreviewRow[];
  counts: {
    total: number;
    valid: number;
    unchanged: number;
    invalid: number;
    duplicate: number;
    notFound: number;
    newProducts: number;
  };
}

/**
 * Parses the workbook into rows. Throws only for a file that cannot be read at
 * all — per-row problems are verdicts, not exceptions, because §8 requires the
 * operator to *see* the bad rows rather than just be told the file failed.
 */
async function parseWorkbook(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<ParsedRow[]> {
  if (!ACCEPTED_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext))) {
    throw validationFailed("Upload an .xlsx file exported from Excel or Sheets.");
  }
  const limits = await getSpreadsheetLimits();
  if (buffer.byteLength > limits.maxBytes) {
    throw validationFailed(
      `File is too large. The limit is ${limits.maxBytes / 1024 / 1024} MB.`,
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw validationFailed("That file could not be read as a spreadsheet.");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw validationFailed("The workbook has no sheets.");

  // Header row maps column index → field name.
  const headerRow = sheet.getRow(1);
  const columns = new Map<number, string>();
  headerRow.eachCell((cell, colNumber) => {
    const field = normaliseHeader(String(cell.value ?? ""));
    if (field) columns.set(colNumber, field);
  });

  if (!Array.from(columns.values()).includes("productCode")) {
    throw validationFailed(
      'The sheet needs a "Product ID" column. Download the template for the expected format.',
    );
  }
  if (
    !Array.from(columns.values()).some((f) =>
      ["price", "onlinePrice", "offlinePrice"].includes(f),
    )
  ) {
    throw validationFailed('The sheet needs a "Price" column.');
  }

  const rows: ParsedRow[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    if (rows.length >= limits.maxRows) return;

    const raw: Record<string, unknown> = {};
    for (const [colNumber, field] of columns) {
      raw[field] = sanitiseCell(row.getCell(colNumber).value);
    }

    // Skip entirely blank rows rather than reporting them as errors — trailing
    // blank rows are an artefact of how spreadsheets are saved, not a mistake.
    const hasContent = Object.values(raw).some((v) => String(v ?? "") !== "");
    if (!hasContent) return;

    rows.push({
      rowNumber,
      productCode: String(raw.productCode ?? "").trim(),
      productName: String(raw.productName ?? "").trim(),
      unit: String(raw.unit ?? "").trim(),
      category: String(raw.category ?? "").trim(),
      subCategory: String(raw.subCategory ?? "").trim(),
      description: String(raw.description ?? "").trim(),
      specifications: String(raw.specifications ?? "").trim(),
      pricePaise: parseRupeesToPaise(
        raw.price ?? raw.onlinePrice ?? raw.offlinePrice,
      ),
      raw,
    });
  });

  if (rows.length === 0) {
    throw validationFailed("The sheet has no data rows.");
  }
  return rows;
}

/**
 * Phase one: validate a sheet against a shop's catalogue and persist the
 * verdict. Nothing about the shop's live prices changes here.
 */
export async function validateUpload(
  input: {
    shopId: string;
    fileName: string;
    buffer: ArrayBuffer;
    uploadType?: "GOODS" | "PRICES";
  },
  actor: Actor,
): Promise<UploadPreview> {
  const parsed = await parseWorkbook(input.buffer, input.fileName);

  const [shop] = await db
    .select({ id: shops.id })
    .from(shops)
    .where(and(eq(shops.id, input.shopId), isNull(shops.deletedAt)))
    .limit(1);
  if (!shop) throw notFound("Shop");

  // Resolve every referenced product code against THIS shop's catalogue in one
  // query — a code that belongs to another shop must read as NOT_FOUND, which
  // is also what stops a sheet reaching across shops.
  const codes = parsed.map((r) => r.productCode).filter(Boolean);
  const catalogue = codes.length
    ? await db
        .select({
          shopProductId: shopProducts.id,
          code: products.code,
          name: products.name,
          unit: products.unit,
          onlinePricePaise: shopProducts.onlinePricePaise,
        })
        .from(shopProducts)
        .innerJoin(products, eq(products.id, shopProducts.productId))
        .where(
          and(
            eq(shopProducts.shopId, input.shopId),
            inArray(products.code, codes),
            isNull(shopProducts.deletedAt),
          ),
        )
    : [];

  const byCode = new Map(catalogue.map((c) => [c.code, c]));
  const isGoods = input.uploadType === "GOODS";

  const seenCodes = new Set<string>();

  const rows: PreviewRow[] = await Promise.all(
    parsed.map(async (row): Promise<PreviewRow> => {
      const base = {
        ...row,
        matchedShopProductId: null as string | null,
        matchedProductId: null as string | null,
        possibleDuplicateProductId: null as string | null,
        possibleDuplicateName: null as string | null,
        previousPricePaise: null as number | null,
        differencePaise: null as number | null,
      };

      // A GOODS row for a brand-new product legitimately has no code yet —
      // only PRICES mode (updating something that must already exist) requires
      // one. Everything below this still applies to both modes identically.
      if (!row.productCode && !(isGoods && row.productName)) {
        return {
          ...base,
          status: "MISSING_FIELD",
          errorMessage: isGoods
            ? "Both Product ID and Product Name are blank."
            : "Product ID is blank.",
        };
      }

      if (row.productCode) {
        if (seenCodes.has(row.productCode)) {
          return {
            ...base,
            status: "DUPLICATE",
            errorMessage: `Product ID ${row.productCode} appears more than once.`,
          };
        }
        seenCodes.add(row.productCode);
      }

      const match = row.productCode ? byCode.get(row.productCode) : undefined;

      // Found in THIS shop's own catalogue — a price update, exactly as PRICES
      // mode has always handled it. Identical for both modes.
      if (match) {
        if (row.pricePaise == null) {
          return {
            ...base,
            matchedShopProductId: match.shopProductId,
            previousPricePaise: match.onlinePricePaise,
            status: "INVALID_PRICE",
            errorMessage: "Price is missing or not a valid amount.",
          };
        }
        const previous = match.onlinePricePaise;
        if (previous === row.pricePaise) {
          return {
            ...base,
            matchedShopProductId: match.shopProductId,
            previousPricePaise: previous,
            differencePaise: 0,
            status: "NO_CHANGE",
            errorMessage: null,
          };
        }
        return {
          ...base,
          matchedShopProductId: match.shopProductId,
          previousPricePaise: previous,
          differencePaise: previous == null ? null : row.pricePaise - previous,
          status: "VALID",
          errorMessage: null,
        };
      }

      // PRICES mode stops here — updating a price for a product this shop
      // doesn't carry is not something a price sheet may do (§21 "unknown
      // products" stays blocked).
      if (!isGoods) {
        return {
          ...base,
          status: "NOT_FOUND",
          errorMessage: `${row.productCode} is not in this shop's catalogue.`,
        };
      }

      // GOODS mode: not in this shop yet. Try the CENTRAL catalogue by code —
      // another shop may already sell this exact product.
      if (row.productCode) {
        const [central] = await db
          .select({
            id: products.id,
            name: products.name,
            categoryName: productCategories.name,
            carried: sql<boolean>`${shopCarriesProductCategory(input.shopId, products.categoryId)}`,
          })
          .from(products)
          .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
          .where(
            and(
              eq(products.code, row.productCode),
              eq(products.approvalStatus, "APPROVED"),
              isNull(products.deletedAt),
            ),
          )
          .limit(1);
        if (central) {
          if (!central.carried) {
            return {
              ...base,
              matchedProductId: central.id,
              status: "NOT_FOUND",
              errorMessage: `${row.productCode} is in the "${central.categoryName}" category, which this shop does not carry. Add the category to the shop first.`,
            };
          }
          if (row.pricePaise == null) {
            return {
              ...base,
              matchedProductId: central.id,
              status: "INVALID_PRICE",
              errorMessage: "Price is missing or not a valid amount.",
            };
          }
          return {
            ...base,
            matchedProductId: central.id,
            status: "VALID",
            differencePaise: null,
            errorMessage: null,
          };
        }
      }

      // Nothing matched by code — this is a genuinely new product. It needs a
      // name; a blank category means General.
      if (!row.productName) {
        return {
          ...base,
          status: "MISSING_FIELD",
          errorMessage: `${row.productCode || "(blank Product ID)"} was not found, and Product Name is blank so a new product cannot be created.`,
        };
      }

      const [category] = row.category
        ? await db
            .select({ id: productCategories.id })
            .from(productCategories)
            .where(
              and(
                sql`lower(${productCategories.name}) = ${row.category.toLowerCase()}`,
                eq(productCategories.isActive, true),
                isNull(productCategories.deletedAt),
              ),
            )
            .limit(1)
        : [await ensureGeneralCategory()];
      if (!category) {
        return {
          ...base,
          status: "NOT_FOUND",
          errorMessage: `Unknown category "${row.category}" — ask an admin to create it first.`,
        };
      }

      if (row.pricePaise == null) {
        return {
          ...base,
          status: "INVALID_PRICE",
          errorMessage: "Price is missing or not a valid amount.",
        };
      }

      const { exact, similar } = await findSimilarProducts(row.productName, category.id);
      if (exact) {
        return {
          ...base,
          matchedProductId: exact.id,
          status: "VALID",
          errorMessage: null,
        };
      }

      return {
        ...base,
        status: "NEW_PRODUCT",
        possibleDuplicateProductId: similar[0]?.id ?? null,
        possibleDuplicateName: similar[0]?.name ?? null,
        errorMessage:
          similar.length > 0
            ? `This looks similar to an existing product: ${similar.map((p) => p.name).join(", ")}. It will still be created as new unless you fix the sheet.`
            : null,
      };
    }),
  );

  // Two NEW_PRODUCT rows for the same name would create it twice — caught here
  // as a synchronous pass over the resolved array rather than a Set mutated
  // inside the async map above: every row's callback runs concurrently, so a
  // shared Set written after an `await` races (two rows can both pass the
  // "have I seen this name" check before either records it).
  const seenNewProductNames = new Set<string>();
  for (const row of rows) {
    if (row.status !== "NEW_PRODUCT") continue;
    const nameKey = row.productName.trim().toLowerCase();
    if (seenNewProductNames.has(nameKey)) {
      row.status = "DUPLICATE";
      row.errorMessage = `"${row.productName}" appears more than once.`;
    } else {
      seenNewProductNames.add(nameKey);
    }
  }

  const counts = {
    total: rows.length,
    // NEW_PRODUCT rows are folded into "valid" for the stored summary — like
    // VALID they will be acted on when applied — but stay distinct on the row
    // itself so the preview UI can label them "New" rather than "Update".
    valid: rows.filter((r) => r.status === "VALID" || r.status === "NEW_PRODUCT")
      .length,
    unchanged: rows.filter((r) => r.status === "NO_CHANGE").length,
    invalid: rows.filter((r) =>
      ["INVALID_PRICE", "MISSING_FIELD"].includes(r.status),
    ).length,
    duplicate: rows.filter((r) => r.status === "DUPLICATE").length,
    notFound: rows.filter((r) => r.status === "NOT_FOUND").length,
    newProducts: rows.filter((r) => r.status === "NEW_PRODUCT").length,
  };

  return db.transaction(async (tx) => {
    const [upload] = await tx
      .insert(excelUploads)
      .values({
        shopId: input.shopId,
        uploadedBy: actor.id,
        uploadType: input.uploadType ?? "PRICES",
        status: "VALIDATED",
        fileName: input.fileName,
        fileSizeBytes: input.buffer.byteLength,
        totalRows: counts.total,
        validRows: counts.valid,
        invalidRows: counts.invalid,
        unchangedRows: counts.unchanged,
        duplicateRows: counts.duplicate,
        notFoundRows: counts.notFound,
        summary: counts,
      })
      .returning();

    if (rows.length > 0) {
      await tx.insert(excelUploadItems).values(
        rows.map((r) => ({
          uploadId: upload.id,
          rowNumber: r.rowNumber,
          rawData: r.raw,
          productCode: r.productCode || null,
          productName: r.productName || null,
          unit: r.unit || null,
          parsedPricePaise: r.pricePaise,
          previousPricePaise: r.previousPricePaise,
          matchedShopProductId: r.matchedShopProductId,
          matchedProductId: r.matchedProductId,
          possibleDuplicateProductId: r.possibleDuplicateProductId,
          status: r.status,
          errorMessage: r.errorMessage,
        })),
      );
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.EXCEL_UPLOADED,
        entityType: "excel_upload",
        entityId: upload.id,
        newValue: { shopId: input.shopId, fileName: input.fileName, ...counts },
      },
      tx,
    );

    return {
      uploadId: upload.id,
      shopId: input.shopId,
      fileName: input.fileName,
      rows,
      counts,
    };
  });
}

/**
 * Phase two: apply the VALID rows of a previously validated upload.
 *
 * Routed through the same authority as a manual edit: an owner's upload goes
 * live, an operator's becomes a pending batch for the owner to approve (§6).
 * Invalid rows are simply never included — §8's "do not apply invalid records".
 */
export async function applyUpload(
  uploadId: string,
  actor: Actor,
): Promise<{
  applied: number;
  pending: number;
  created: number;
  wentLive: boolean;
}> {
  return db.transaction(async (tx) => {
    const [upload] = await tx
      .select()
      .from(excelUploads)
      .where(eq(excelUploads.id, uploadId))
      .for("update")
      .limit(1);
    if (!upload) throw notFound("Upload");
    if (upload.status !== "VALIDATED") {
      throw conflict(`This upload has already been ${upload.status.toLowerCase()}.`);
    }

    const [shop] = await tx
      .select({ id: shops.id, ownerId: shops.ownerId })
      .from(shops)
      .where(eq(shops.id, upload.shopId))
      .limit(1);
    if (!shop) throw notFound("Shop");

    const items = await tx
      .select()
      .from(excelUploadItems)
      .where(
        and(
          eq(excelUploadItems.uploadId, uploadId),
          inArray(excelUploadItems.status, ["VALID", "NEW_PRODUCT"]),
        ),
      );

    const priceUpdateItems = items.filter(
      (i) => i.matchedShopProductId && i.parsedPricePaise != null,
    );
    // GOODS mode only: matched the central catalogue but this shop doesn't
    // carry it yet, or matched nothing and needs to be created outright.
    const attachItems = items.filter(
      (i) => !i.matchedShopProductId && i.matchedProductId,
    );
    const newProductItems = items.filter(
      (i) => !i.matchedShopProductId && !i.matchedProductId,
    );

    let applied = 0;
    let pending = 0;
    let created = 0;
    const wentLive = appliesImmediately(actor, shop.ownerId);
    const actorForWrites = {
      id: actor.id,
      role: actor.role as "SHOP_OWNER" | "OPERATOR" | "ADMIN",
    };

    // 1. Price updates on products the shop already carries — unchanged from
    //    before this feature: same function, same approval rule.
    const priceChanges = priceUpdateItems.map((i) => ({
      shopProductId: i.matchedShopProductId as string,
      priceType: "ONLINE" as const,
      proposedPricePaise: i.parsedPricePaise as number,
    }));
    if (priceChanges.length > 0) {
      if (wentLive) {
        for (const change of priceChanges) {
          await updateShopProduct(
            change.shopProductId,
            { onlinePricePaise: change.proposedPricePaise },
            actorForWrites,
            tx,
          );
          applied += 1;
        }
      } else {
        const { requests } = await submitPriceRequests(
          {
            shopId: upload.shopId,
            changes: priceChanges,
            note: `Excel upload: ${upload.fileName}`,
            excelUploadId: upload.id,
          },
          actor,
          tx,
        );
        pending += requests.length;
      }
    }

    // 2. Attach a product that exists centrally but not yet in this shop.
    const attachRequests: { shopProductId: string; priceType: "ONLINE"; proposedPricePaise: number }[] = [];
    for (const item of attachItems) {
      const shopProduct = await createShopProduct(
        {
          shopId: upload.shopId,
          productId: item.matchedProductId as string,
          onlinePricePaise: wentLive ? item.parsedPricePaise : null,
          onlineSaleEnabled: wentLive && item.parsedPricePaise != null,
          offlineSaleEnabled: false,
        },
        actorForWrites,
        tx,
      );
      created += 1;
      if (!wentLive && item.parsedPricePaise != null) {
        attachRequests.push({
          shopProductId: shopProduct.id,
          priceType: "ONLINE",
          proposedPricePaise: item.parsedPricePaise,
        });
      }
    }

    // 3. Genuinely new products (§6 "create a new product and associate it
    //    with the selected shop").
    for (const item of newProductItems) {
      const raw = (item.rawData ?? {}) as Record<string, unknown>;
      const categoryName = String(raw.category ?? "").trim();

      // Category is re-resolved here (by name, case-insensitive) rather than
      // carried from validateUpload, so a category renamed between preview and
      // confirm is caught rather than silently misfiled.
      const resolvedCategory = categoryName
        ? await tx.query.productCategories.findFirst({
            where: and(
              sql`lower(${productCategories.name}) = ${categoryName.toLowerCase()}`,
              eq(productCategories.isActive, true),
              isNull(productCategories.deletedAt),
            ),
          })
        : await ensureGeneralCategory(tx);
      if (!resolvedCategory) {
        throw conflict(
          `Category "${categoryName}" for row ${item.rowNumber} is no longer available. Re-upload the sheet.`,
        );
      }

      const result = await createProductForShop(
        {
          shopId: upload.shopId,
          categoryId: resolvedCategory.id,
          name: item.productName ?? "",
          description: String(raw.description ?? "").trim() || null,
          specifications: String(raw.specifications ?? "").trim() || null,
          subCategory: String(raw.subCategory ?? "").trim() || null,
          unit: item.unit ?? "unit",
          onlinePricePaise: item.parsedPricePaise,
          onlineSaleEnabled: item.parsedPricePaise != null,
          offlineSaleEnabled: false,
          confirmDuplicate: true, // already surfaced and accepted at preview time
        },
        actor,
        wentLive,
        tx,
      );
      created += 1;
      if (!wentLive && item.parsedPricePaise != null) {
        attachRequests.push({
          shopProductId: result.shopProduct.id,
          priceType: "ONLINE",
          proposedPricePaise: item.parsedPricePaise,
        });
      }
    }

    if (attachRequests.length > 0) {
      const { requests } = await submitPriceRequests(
        {
          shopId: upload.shopId,
          changes: attachRequests,
          note: `Excel upload (new products): ${upload.fileName}`,
          excelUploadId: upload.id,
        },
        actor,
        tx,
      );
      pending += requests.length;
    }

    await tx
      .update(excelUploads)
      .set({ status: "APPLIED", appliedAt: new Date() })
      .where(eq(excelUploads.id, uploadId));

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.EXCEL_APPLIED,
        entityType: "excel_upload",
        entityId: uploadId,
        newValue: { applied, pending, created, wentLive },
      },
      tx,
    );

    return { applied, pending, created, wentLive };
  });
}

export async function cancelUpload(
  uploadId: string,
  actor: Actor,
): Promise<void> {
  const [upload] = await db
    .select({ status: excelUploads.status })
    .from(excelUploads)
    .where(eq(excelUploads.id, uploadId))
    .limit(1);
  if (!upload) throw notFound("Upload");
  if (upload.status !== "VALIDATED") {
    throw conflict("Only a validated upload awaiting confirmation can be cancelled.");
  }

  await db
    .update(excelUploads)
    .set({ status: "CANCELLED" })
    .where(eq(excelUploads.id, uploadId));

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.EXCEL_CANCELLED,
    entityType: "excel_upload",
    entityId: uploadId,
  });
}

export async function getUploadPreview(uploadId: string): Promise<UploadPreview> {
  const [upload] = await db
    .select()
    .from(excelUploads)
    .where(eq(excelUploads.id, uploadId))
    .limit(1);
  if (!upload) throw notFound("Upload");

  const items = await db
    .select()
    .from(excelUploadItems)
    .where(eq(excelUploadItems.uploadId, uploadId))
    .orderBy(excelUploadItems.rowNumber);

  return {
    uploadId: upload.id,
    shopId: upload.shopId,
    fileName: upload.fileName,
    rows: items.map((i) => {
      const raw = (i.rawData ?? {}) as Record<string, unknown>;
      return {
        rowNumber: i.rowNumber,
        productCode: i.productCode ?? "",
        productName: i.productName ?? "",
        unit: i.unit ?? "",
        category: String(raw.category ?? ""),
        subCategory: String(raw.subCategory ?? ""),
        description: String(raw.description ?? ""),
        specifications: String(raw.specifications ?? ""),
        pricePaise: i.parsedPricePaise,
        raw,
        status: i.status,
        errorMessage: i.errorMessage,
        matchedShopProductId: i.matchedShopProductId,
        matchedProductId: i.matchedProductId,
        possibleDuplicateProductId: i.possibleDuplicateProductId,
        possibleDuplicateName: null,
        previousPricePaise: i.previousPricePaise,
        differencePaise:
          i.parsedPricePaise != null && i.previousPricePaise != null
            ? i.parsedPricePaise - i.previousPricePaise
            : null,
      };
    }),
    counts: {
      total: upload.totalRows,
      valid: upload.validRows,
      unchanged: upload.unchangedRows,
      invalid: upload.invalidRows,
      duplicate: upload.duplicateRows,
      notFound: upload.notFoundRows,
      newProducts: items.filter((i) => i.status === "NEW_PRODUCT").length,
    },
  };
}

export async function listUploadsForShop(
  shopId: string,
  limit = 50,
): Promise<ExcelUpload[]> {
  return db
    .select()
    .from(excelUploads)
    .where(eq(excelUploads.shopId, shopId))
    .orderBy(excelUploads.createdAt)
    .limit(limit);
}

/**
 * Builds the downloadable template (§9), pre-filled with the shop's current
 * catalogue so the operator edits real prices instead of typing product ids.
 */
export async function buildTemplate(
  shopId: string,
  client: DbClient = db,
  uploadType: "PRICES" | "GOODS" = "PRICES",
): Promise<ArrayBuffer> {
  const rows = await client
    .select({
      code: products.code,
      name: products.name,
      unit: products.unit,
      category: productCategories.name,
      onlinePricePaise: shopProducts.onlinePricePaise,
      offlinePricePaise: shopProducts.offlinePricePaise,
    })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(and(eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(uploadType === "GOODS" ? "Goods" : "Prices");

  if (uploadType === "GOODS") {
    sheet.columns = [
      { header: "Product ID", key: "code", width: 14 },
      { header: "Product Name", key: "name", width: 28 },
      { header: "Description", key: "description", width: 30 },
      { header: "Specifications", key: "specifications", width: 30 },
      { header: "Category", key: "category", width: 18 },
      { header: "Sub Category", key: "subCategory", width: 16 },
      { header: "Unit", key: "unit", width: 10 },
      { header: "Price", key: "price", width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      sheet.addRow({
        code: row.code,
        name: row.name,
        category: row.category,
        unit: row.unit,
        price: row.onlinePricePaise != null ? row.onlinePricePaise / 100 : "",
      });
    }
    // One blank starter row for a genuinely new product — Product ID stays
    // empty; the sheet is matched by name + category instead.
    sheet.addRow({ code: "", name: "", category: "", unit: "", price: "" });
  } else {
    sheet.columns = [
      { header: "Product ID", key: "code", width: 14 },
      { header: "Product Name", key: "name", width: 32 },
      { header: "Unit", key: "unit", width: 10 },
      { header: "Price", key: "price", width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      sheet.addRow({
        code: row.code,
        name: row.name,
        unit: row.unit,
        price: row.onlinePricePaise != null ? row.onlinePricePaise / 100 : "",
      });
    }
  }

  const notes = workbook.addWorksheet("How to use");
  if (uploadType === "GOODS") {
    notes.addRows([
      ["Required columns", "Product Name, Unit, Price (Category defaults to General)"],
      ["Product ID", "Leave blank for a new product — it will be assigned automatically"],
      ["Optional columns", "Description, Specifications, Sub Category"],
      ["Category", "Must match an existing category name exactly (case-insensitive). Leave blank for General"],
      ["Price format", "Rupees, e.g. 72 or 72.50 — do not include the ₹ sign"],
      ["Note", "A Product ID that already exists updates that product's price instead of creating a new one"],
    ]);
  } else {
    notes.addRows([
      ["Required columns", "Product ID, Price"],
      ["Optional columns", "Product Name, Unit, Category, Online Price, Offline Price"],
      ["Price format", "Rupees, e.g. 72 or 72.50 — do not include the ₹ sign"],
      ["Do not", "change or delete the Product ID column"],
      ["Note", "Rows with an unknown Product ID or an invalid price are reported and skipped"],
    ]);
  }

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
