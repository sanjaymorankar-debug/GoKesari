/**
 * Bulk product upload — file → rows (docs/product-import-2026-10 §1).
 *
 * Pure apart from reading the bytes: no database. The service stores what this
 * returns and plans against the catalogue separately, so the parser can be
 * tested against fixture files alone.
 *
 * Rules carried out here:
 *  - every field is optional; a value that cannot be read is a warning;
 *  - only a fully empty row is skipped (counted, not stored);
 *  - Amazon's example row (ABC123), its notice row ("We've prefilled…") and
 *    the GoKesari template's "EXAMPLE – delete this row" are not data;
 *  - every non-empty cell of every row is kept (`raw`, and grouped by section
 *    in `attributes`).
 */
import type { ImportSourceFormat } from "@/lib/product-import";

import { detectHeader, firstRowHeader, type ColumnDef } from "./columns";
import { extractRow, mapColumns, type ImportFields } from "./fields";
import { readSpreadsheet, type CellValue } from "./grid";

export interface ParsedRow {
  rowNumber: number;
  fields: ImportFields;
  raw: Record<string, CellValue>;
  attributes: Record<string, Record<string, unknown>>;
  warnings: string[];
}

export interface ParsedFile {
  format: ImportSourceFormat;
  sheetName: string;
  sheetNames: string[];
  columns: ColumnDef[];
  rows: ParsedRow[];
  /** Fully empty rows between data rows. */
  emptyRows: number;
  /** Example / notice rows recognised and left out, by row number. */
  skippedTemplateRows: number[];
  /** File-level notes for the preview. */
  messages: string[];
  hasMacros: boolean;
  /** Data rows beyond the limit were not read. */
  truncated: boolean;
  /** Columns mapped to a GoKesari field, and columns kept only as attributes. */
  mappedFields: string[];
  unmappedColumns: number;
}

const NOTICE = /prefilled|do not delete|don['’]t delete|please do not|this row is (for|an) /i;
const EXAMPLE_MARK = /^example\b/i;
const AMAZON_EXAMPLE_SKU = /^abc123$/i;

const filled = (cells: CellValue[]) => cells.filter((c) => c != null && String(c).trim() !== "");

function isTemplateRow(cells: CellValue[], skuCols: ColumnDef[]): boolean {
  const values = filled(cells);
  if (values.length === 0) return false;
  if (values.length === 1 && NOTICE.test(String(values[0]))) return true;
  if (skuCols.some((c) => AMAZON_EXAMPLE_SKU.test(String(cells[c.index] ?? "").trim()))) return true;
  return values.some((v) => typeof v === "string" && EXAMPLE_MARK.test(v.trim()) && /delete/i.test(v));
}

export async function parseImportFile(
  bytes: Buffer,
  fileName: string,
  options: { maxRows: number },
): Promise<ParsedFile> {
  const grid = await readSpreadsheet(bytes, fileName, { maxRows: options.maxRows });
  const messages: string[] = [];
  if (grid.hasMacros) messages.push("The file contains macros. They were not run — only the cell values were read.");
  if (grid.kind === "xlsx" && grid.sheetNames.length > 1) messages.push(`Read the sheet "${grid.sheetName}".`);

  let layout = detectHeader(grid.rows);
  if (!layout) {
    layout = firstRowHeader(grid.rows);
    if (layout) messages.push("No standard heading (SKU, Item Name, Product Name…) was found; the first row was used as the heading.");
  }
  if (!layout) {
    return {
      format: grid.kind === "csv" ? "CSV" : "SPREADSHEET",
      sheetName: grid.sheetName,
      sheetNames: grid.sheetNames,
      columns: [],
      rows: [],
      emptyRows: 0,
      skippedTemplateRows: [],
      messages: [...messages, "The sheet is empty."],
      hasMacros: grid.hasMacros,
      truncated: false,
      mappedFields: [],
      unmappedColumns: 0,
    };
  }

  const map = mapColumns(layout.columns);
  const skuCols = map.byField.get("sku") ?? [];
  const labels = new Set(layout.columns.map((c) => c.label.toLowerCase()));
  const format: ImportSourceFormat = layout.hasAttributeKeys
    ? "AMAZON_TEMPLATE"
    : grid.kind === "csv"
      ? "CSV"
      : labels.has("product name") && labels.has("selling price") && labels.has("quantity")
        ? "GOKESARI_TEMPLATE"
        : "SPREADSHEET";
  if (format === "AMAZON_TEMPLATE") messages.push(`Amazon Seller Central template: ${layout.columns.length} columns.`);

  const rows: ParsedRow[] = [];
  const skippedTemplateRows: number[] = [];
  let pendingEmpty = 0;
  let emptyRows = 0;
  let truncated = grid.truncated;
  for (const row of grid.rows.slice(layout.dataStart)) {
    if (filled(row.cells).length === 0) {
      pendingEmpty += 1;
      continue;
    }
    if (isTemplateRow(row.cells, skuCols)) {
      skippedTemplateRows.push(row.rowNumber);
      continue;
    }
    // Blank rows count only when data follows them (a template's trailing formatted rows are not "skipped rows").
    emptyRows += pendingEmpty;
    pendingEmpty = 0;
    if (rows.length >= options.maxRows) {
      truncated = true;
      break;
    }
    const extracted = extractRow(row.cells, map, layout.columns);
    rows.push({ rowNumber: row.rowNumber, ...extracted });
  }
  if (skippedTemplateRows.length) {
    messages.push(`Left out the template's example / notice row${skippedTemplateRows.length > 1 ? "s" : ""}: ${skippedTemplateRows.join(", ")}.`);
  }
  if (truncated) messages.push(`Only the first ${options.maxRows} data rows were read; split the file to upload the rest.`);

  return {
    format,
    sheetName: grid.sheetName,
    sheetNames: grid.sheetNames,
    columns: layout.columns,
    rows,
    emptyRows,
    skippedTemplateRows,
    messages,
    hasMacros: grid.hasMacros,
    truncated,
    mappedFields: [...map.byField.keys()],
    unmappedColumns: map.unmapped.length,
  };
}
