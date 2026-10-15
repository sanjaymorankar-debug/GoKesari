/**
 * Bulk product upload (docs/product-import-2026-10) — the vocabulary shared by
 * the schema, the service, the API and the screens. Pure: no server imports,
 * so client components can use it too.
 */

/** A job's life: uploaded → parsing → preview_ready → importing → completed (or failed / cancelled). */
export const IMPORT_JOB_STATUSES = [
  "uploaded",
  "parsing",
  "preview_ready",
  "importing",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/**
 * A row's state. Before the commit: ready (will be written), skipped (empty
 * row, or an Edit/Delete with nothing to change). After: created / updated /
 * deactivated, or failed with its reason.
 */
export const IMPORT_ROW_STATUSES = ["ready", "skipped", "created", "updated", "deactivated", "failed"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** What a row asks for (column "Listing Action" / "Action"). Blank = UPSERT. */
export const IMPORT_ROW_ACTIONS = ["UPSERT", "EDIT", "DELETE"] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];

/** How the row found its product: the shop's SKU, the master barcode, name + brand, or nothing (a new product). */
export const IMPORT_MATCH_TYPES = ["SKU", "BARCODE", "NAME", "NEW", "NONE"] as const;
export type ImportMatchType = (typeof IMPORT_MATCH_TYPES)[number];

/** SET: stock becomes the file's Quantity (default). ADD: the file's Quantity is added to current stock. */
export const INVENTORY_MODES = ["SET", "ADD"] as const;
export type InventoryMode = (typeof INVENTORY_MODES)[number];

export const IMPORT_SOURCE_FORMATS = ["AMAZON_TEMPLATE", "GOKESARI_TEMPLATE", "SPREADSHEET", "CSV"] as const;
export type ImportSourceFormat = (typeof IMPORT_SOURCE_FORMATS)[number];

/** The planned outcome shown on the preview, before anything is written. */
export const IMPORT_PLANNED_OUTCOMES = ["create", "update", "deactivate", "skip"] as const;
export type ImportPlannedOutcome = (typeof IMPORT_PLANNED_OUTCOMES)[number];

export interface ImportCounts {
  totalRows: number;
  /** Rows parsed so far (progress while parsing). */
  parsedRows: number;
  /** Rows written so far (progress while importing). */
  processedRows: number;
  newProducts: number;
  updates: number;
  deactivations: number;
  skipped: number;
  withWarnings: number;
  created: number;
  updated: number;
  deactivated: number;
  failed: number;
  imagesQueued: number;
  imagesSaved: number;
  imagesFailed: number;
}

export const EMPTY_COUNTS: ImportCounts = {
  totalRows: 0,
  parsedRows: 0,
  processedRows: 0,
  newProducts: 0,
  updates: 0,
  deactivations: 0,
  skipped: 0,
  withWarnings: 0,
  created: 0,
  updated: 0,
  deactivated: 0,
  failed: 0,
  imagesQueued: 0,
  imagesSaved: 0,
  imagesFailed: 0,
};

/** What the preview shows for one row (product_import_rows.plan). */
export interface ImportRowPlan {
  outcome: ImportPlannedOutcome;
  sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  mrpPaise: number | null;
  pricePaise: number | null;
  /** Stock now (null for a new listing). */
  currentQty: number | null;
  /** The file's Quantity, when it is a usable whole number ≥ 0 (the last one, for rows merged by SKU). */
  fileQty: number | null;
  /** For rows merged by SKU: their quantities added up (what "Add" mode adds). Same as fileQty otherwise. */
  fileQtySum: number | null;
}

/** Stock after the import for a planned row, in the given mode; null = unchanged. */
export function plannedStock(plan: Pick<ImportRowPlan, "outcome" | "currentQty" | "fileQty" | "fileQtySum">, mode: InventoryMode): number | null {
  if (plan.outcome === "deactivate") return 0;
  if (plan.outcome === "skip") return null;
  if (mode === "ADD") {
    if (plan.fileQtySum == null) return plan.currentQty == null ? 0 : null;
    return (plan.currentQty ?? 0) + plan.fileQtySum;
  }
  if (plan.fileQty == null) return plan.currentQty == null ? 0 : null;
  return plan.fileQty;
}

/** File types the upload accepts, for <input accept> (extensions plus MIME types, so phone pickers offer them). */
export const IMPORT_ACCEPT = [
  ".xlsx",
  ".xlsm",
  ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "text/csv",
  "text/comma-separated-values",
  "application/vnd.ms-excel",
  // Files saved from WhatsApp or e-mail often arrive with no specific type.
  "application/octet-stream",
].join(",");
