/**
 * Reads an uploaded spreadsheet into plain rows of cell values
 * (docs/product-import-2026-10).
 *
 * Accepted: .xlsx, .xlsm (Office Open XML, i.e. a ZIP) and .csv. The file
 * type is decided from the bytes, never the name. An .xlsm is read as data
 * only: ExcelJS parses the sheet XML and never touches xl/vbaProject.bin —
 * there is nothing on the server that could run a macro. Formulas are not
 * evaluated either; the value Excel last saved for the cell is used.
 *
 * The sheet: the one named "Template" (Amazon Seller Central's data sheet) if
 * there is one, otherwise the first sheet whose top rows carry a product
 * heading (SKU, Item Name, Product Name…), otherwise the first sheet.
 */
import { Readable } from "node:stream";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { validationFailed } from "@/lib/errors";
import { parseDelimited } from "@/server/pmd/sources/delimited";

export type CellValue = string | number | boolean | null;

export interface GridRow {
  /** 1-based, as Excel numbers it. */
  rowNumber: number;
  /** 0-based by column. */
  cells: CellValue[];
}

export interface Grid {
  kind: "xlsx" | "csv";
  sheetName: string;
  sheetNames: string[];
  rows: GridRow[];
  /** More rows than the limit: reading stopped. */
  truncated: boolean;
  /** The workbook carries a VBA project (an .xlsm with macros). It was ignored. */
  hasMacros: boolean;
}

/** Rows above the data that a template may have (Amazon: 7). */
const HEADER_ALLOWANCE = 20;
/** How far down a sheet to look for its heading row. */
export const HEADER_SCAN_ROWS = 15;

const PRODUCT_HEADINGS = /^(sku|seller sku|item sku|item name|product name|title|brand name|barcode|quantity( \(in\))?)$/i;

/** Turns any ExcelJS cell value into a plain value: text, number, boolean, or a date as yyyy-mm-dd. */
export function plainCell(v: ExcelJS.CellValue | undefined): CellValue {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  const o = v as unknown as Record<string, unknown>;
  if (Array.isArray(o.richText)) {
    const t = (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    return t.trim() === "" ? null : t;
  }
  if ("error" in o) return null;
  if ("formula" in o || "sharedFormula" in o) return plainCell(o.result as ExcelJS.CellValue);
  if ("hyperlink" in o) return plainCell((o.text as ExcelJS.CellValue) || (o.hyperlink as string));
  return null;
}

function rowCells(values: ExcelJS.CellValue[] | undefined): CellValue[] {
  // ExcelJS rows are 1-based: index 0 is always empty.
  const out: CellValue[] = [];
  if (!values) return out;
  for (let c = 1; c < values.length; c += 1) out[c - 1] = plainCell(values[c]);
  for (let c = 0; c < out.length; c += 1) if (out[c] === undefined) out[c] = null;
  return out;
}

const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

/** Does the sheet look like a product sheet — a heading such as SKU or Item Name near the top? */
function looksLikeProductSheet(rows: GridRow[]): boolean {
  return rows
    .slice(0, HEADER_SCAN_ROWS)
    .some((r) => r.cells.some((c) => typeof c === "string" && PRODUCT_HEADINGS.test(c.trim())));
}

interface SheetCandidate {
  name: string;
  rows: GridRow[];
  truncated: boolean;
}

class SheetCollector {
  chosen: SheetCandidate | null = null;
  fallback: SheetCandidate | null = null;
  first: SheetCandidate | null = null;
  names: string[] = [];
  constructor(private readonly maxRows: number) {}

  /** Whether rows of this sheet need keeping (a Template sheet always; others until one qualifies). */
  start(name: string): SheetCandidate | null {
    this.names.push(name);
    if (this.chosen) return null;
    return { name, rows: [], truncated: false };
  }

  push(sheet: SheetCandidate, rowNumber: number, cells: CellValue[]): void {
    if (sheet.rows.length >= this.maxRows + HEADER_ALLOWANCE) {
      sheet.truncated = sheet.truncated || cells.some((c) => c != null);
      return;
    }
    sheet.rows.push({ rowNumber, cells });
  }

  finish(sheet: SheetCandidate): "stop" | "continue" {
    if (sheet.name.trim().toLowerCase() === "template") {
      this.chosen = sheet;
      return "stop";
    }
    if (!this.first) this.first = sheet;
    if (!this.fallback && looksLikeProductSheet(sheet.rows)) this.fallback = sheet;
    else if (this.first !== sheet) sheet.rows = []; // not needed: free it
    return "continue";
  }

  result(): SheetCandidate | null {
    return this.chosen ?? this.fallback ?? this.first;
  }
}

async function readXlsxStream(bytes: Buffer, maxRows: number): Promise<SheetCollector> {
  const collector = new SheetCollector(maxRows);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([bytes]), {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "cache",
    entries: "ignore",
  });
  let position = 0;
  for await (const ws of reader) {
    position += 1;
    const name = String((ws as unknown as { name?: string }).name ?? `Sheet${position}`);
    const sheet = collector.start(name);
    for await (const row of ws) {
      if (sheet) collector.push(sheet, row.number, rowCells(row.values as ExcelJS.CellValue[]));
    }
    if (sheet && collector.finish(sheet) === "stop") break;
  }
  return collector;
}

async function readXlsxMemory(bytes: Buffer, maxRows: number): Promise<SheetCollector> {
  const collector = new SheetCollector(maxRows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  for (const ws of wb.worksheets) {
    const sheet = collector.start(ws.name);
    if (!sheet) continue;
    ws.eachRow({ includeEmpty: false }, (row, n) => collector.push(sheet, n, rowCells(row.values as ExcelJS.CellValue[])));
    if (collector.finish(sheet) === "stop") break;
  }
  return collector;
}

async function hasVbaProject(bytes: Buffer): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
    return Object.keys(zip.files).some((n) => /(^|\/)vbaProject\.bin$/i.test(n));
  } catch {
    return false;
  }
}

function detectDelimiter(firstLine: string): string {
  const counts = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

async function readCsv(bytes: Buffer, maxRows: number): Promise<Grid> {
  let textBytes = bytes;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) textBytes = bytes.subarray(3);
  const head = textBytes.subarray(0, 4096).toString("utf8");
  if (head.includes("\u0000")) throw validationFailed("This file is not a CSV text file. Save it as CSV (UTF-8) or Excel (.xlsx) and upload it again.");
  const delimiter = detectDelimiter(head.split(/\r?\n/)[0] ?? "");
  const rows: GridRow[] = [];
  let truncated = false;
  let n = 0;
  async function* once() {
    yield textBytes;
  }
  try {
    for await (const cells of parseDelimited(once(), { delimiter, maxFieldLength: 100_000 })) {
      n += 1;
      if (rows.length >= maxRows + HEADER_ALLOWANCE) {
        truncated = true;
        continue;
      }
      rows.push({ rowNumber: n, cells: cells.map((c) => (c.trim() === "" ? null : c)) });
    }
  } catch {
    throw validationFailed("The CSV file could not be read. Save it as CSV (comma separated, UTF-8) and upload it again.");
  }
  return { kind: "csv", sheetName: "CSV", sheetNames: ["CSV"], rows, truncated, hasMacros: false };
}

/**
 * The rows of the product sheet. Throws a 422 for a file that is not a
 * spreadsheet this feature reads (with a message the owner can act on).
 */
export async function readSpreadsheet(bytes: Buffer, fileName: string, options: { maxRows: number }): Promise<Grid> {
  if (bytes.length === 0) throw validationFailed("The file is empty.");
  if (isOle(bytes)) {
    throw validationFailed("Old Excel (.xls) files are not supported. In Excel choose File → Save As → Excel Workbook (.xlsx), then upload that.");
  }
  if (!isZip(bytes)) {
    if (/\.(csv|txt|tsv)$/i.test(fileName)) return readCsv(bytes, options.maxRows);
    throw validationFailed("Upload an Excel file (.xlsx or .xlsm) or a CSV file.");
  }
  const hasMacros = await hasVbaProject(bytes);
  let collector: SheetCollector;
  try {
    collector = await readXlsxStream(bytes, options.maxRows);
    if (!collector.result()) collector = await readXlsxMemory(bytes, options.maxRows);
  } catch {
    try {
      collector = await readXlsxMemory(bytes, options.maxRows);
    } catch {
      throw validationFailed("The Excel file could not be opened. Open it in Excel, save it again as .xlsx, and upload it.");
    }
  }
  const sheet = collector.result();
  if (!sheet) throw validationFailed("The Excel file has no sheets.");
  return {
    kind: "xlsx",
    sheetName: sheet.name,
    sheetNames: collector.names,
    rows: sheet.rows,
    truncated: sheet.truncated,
    hasMacros,
  };
}
