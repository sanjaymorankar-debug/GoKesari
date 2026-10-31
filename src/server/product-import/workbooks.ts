/**
 * Files the bulk product upload hands out (docs/product-import-2026-10):
 *   - the GoKesari simple template (GoKesari_Product_Upload_Template.xlsx);
 *   - the result report: the uploaded rows with `status` and `messages` added,
 *     as CSV or XLSX.
 * Every value written into a generated sheet is defanged against formula
 * injection (a cell starting = + - @ is prefixed with ').
 */
import ExcelJS from "exceljs";

import { STANDARD_GST_RATES } from "@/server/gst/product-rates";
import { sanitiseCell } from "@/server/services/excel";

export const TEMPLATE_FILE_NAME = "GoKesari_Product_Upload_Template.xlsx";
export const TEMPLATE_CSV_FILE_NAME = "GoKesari_Product_Upload_Template.csv";

/** The simple template's columns, in order (§6). */
export const SIMPLE_TEMPLATE_COLUMNS = [
  "SKU", "Product Name", "Brand", "Manufacturer", "Category", "Barcode Type", "Barcode", "HSN Code", "GST %", "MRP",
  "Selling Price", "Sale Price", "Sale Start", "Sale End", "Quantity", "Unit", "Goods Type", "Pack Size", "Color", "Size", "Material",
  "Description", "Highlight 1", "Highlight 2", "Highlight 3", "Highlight 4", "Highlight 5", "Keywords", "Main Image URL",
  "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5", "Weight (g)", "Length (cm)", "Width (cm)", "Height (cm)",
  "Country of Origin", "Max Order Qty", "Action",
] as const;

export const BARCODE_TYPE_CHOICES = ["EAN", "UPC", "GTIN", "ISBN", "ASIN", "GTIN Exempt", "Other"];
export const UNIT_CHOICES = ["pcs", "kg", "g", "l", "ml", "pack"];
export const ACTION_CHOICES = ["Upsert", "Edit", "Delete"];
export const GOODS_TYPE_CHOICES = ["Packaged", "Loose"];
export const GST_CHOICES = STANDARD_GST_RATES.map(String);

const EXAMPLE: Record<string, string | number> = {
  SKU: "EXAMPLE – delete this row",
  "Product Name": "Amul Gold Full Cream Milk 500 ml",
  Brand: "Amul",
  Manufacturer: "Gujarat Cooperative Milk Marketing Federation",
  Category: "Milk",
  "Barcode Type": "EAN",
  Barcode: "8901262010016",
  "HSN Code": "04012000",
  "GST %": 0,
  MRP: 34,
  "Selling Price": 33,
  "Sale Price": 32,
  "Sale Start": "01/11/2026",
  "Sale End": "07/11/2026",
  Quantity: 50,
  Unit: "pack",
  "Goods Type": "Packaged",
  "Pack Size": "500 ml",
  Description: "Full cream milk, pasteurised and homogenised.",
  "Highlight 1": "6% fat",
  Keywords: "milk full cream amul gold",
  "Main Image URL": "https://example.com/images/amul-gold-500ml.jpg",
  "Weight (g)": 520,
  "Country of Origin": "India",
  "Max Order Qty": 10,
  Action: "Upsert",
};

const INSTRUCTIONS: string[][] = [
  ["GoKesari bulk product upload — instructions"],
  [""],
  ["ALL COLUMNS ARE OPTIONAL. Fill in what you have; leave the rest blank."],
  ["A blank cell never deletes what is already saved for a product — only cells with a value change it."],
  ["Only a completely empty row is skipped. A value that cannot be read is reported as a warning and the row still goes in."],
  [""],
  ["How a row finds its product (in this order):"],
  ["  1. SKU — your own code for the product in your shop. No SKU? One is made for you (GK-…)."],
  ["  2. Barcode — matched against the GoKesari catalogue."],
  ["  3. Product Name + Brand (+ Size / Color) — an exact match in the catalogue."],
  ["  4. Nothing matched — a new product is added (waiting for approval in the catalogue) and you can sell it in your shop straight away."],
  [""],
  ["Quantity is your stock. On the upload screen choose 'Set stock to file quantity' (default) or 'Add file quantity to current stock'."],
  ["  A blank Quantity leaves the stock as it is. A new product with no Quantity has stock 0 (not orderable until stock is set)."],
  ["MRP and Selling Price apply to your shop only. Prices are in rupees (₹1,299.00, 1299 and 1,299 all work)."],
  ["  The Selling Price may not be above the MRP: the preview flags it and the price is not changed."],
  ["A NEW product needs at least a Product Name. Without one a placeholder name is used and the preview tells you."],
  ["HSN Code: 4, 6 or 8 digits. GST %: choose from the list (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40)."],
  ["Goods Type: Packaged (default) or Loose. Loose goods are sold by weight or volume (Unit kg, g, l or ml), may have stock with decimals (2.5 kg) and carry no MRP."],
  ["To change many prices or stock at once: 'Download my catalogue' on the upload screen, edit the file, and upload it again. Rows are matched on SKU."],
  ["Dates: dd/mm/yyyy or yyyy-mm-dd. Weight in grams, sizes in cm."],
  ["Action: Upsert (add or update — the default), Edit (update only; a row that matches nothing is skipped), Delete (hides the product from customers and sets its stock to 0)."],
  ["Images: http or https links to JPG, PNG or WebP files, up to 5 MB each. They are downloaded after the import."],
  [""],
  ["Row 2 of the Products sheet is an example marked 'EXAMPLE – delete this row'. Delete it or leave it — it is never imported."],
  ["Amazon Seller Central inventory files (.xlsm / .xlsx) can be uploaded as they are, without copying into this template."],
];

export type TemplateRow = Partial<Record<(typeof SIMPLE_TEMPLATE_COLUMNS)[number], string | number | null>>;

/** A workbook in the simple template's layout — dropdowns and the Instructions sheet included — holding `rows`. */
async function templateWorkbook(rows: TemplateRow[], options: { example: boolean }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = SIMPLE_TEMPLATE_COLUMNS.map((header) => ({ header, key: header, width: Math.max(12, header.length + 4) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE7C7" } };
  if (options.example) {
    const example = ws.addRow(SIMPLE_TEMPLATE_COLUMNS.map((c) => EXAMPLE[c] ?? null));
    example.font = { italic: true, color: { argb: "FF8A6D3B" } };
  }
  for (const row of rows) {
    ws.addRow(SIMPLE_TEMPLATE_COLUMNS.map((c) => {
      const v = row[c];
      return typeof v === "string" ? sanitiseCell(v) : (v ?? null);
    }));
  }
  const lastRow = Math.max(5001, rows.length + 1001);

  const col = (name: string) => ws.getColumn(SIMPLE_TEMPLATE_COLUMNS.indexOf(name as (typeof SIMPLE_TEMPLATE_COLUMNS)[number]) + 1).letter;
  // ExcelJS supports range validations at runtime; its type definitions omit them.
  const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
  const list = (name: string, choices: string[]) =>
    validations.add(`${col(name)}2:${col(name)}${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [`"${choices.join(",")}"`],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: name,
      error: `Choose one of: ${choices.join(", ")}`,
    });
  list("Barcode Type", BARCODE_TYPE_CHOICES);
  list("Unit", UNIT_CHOICES);
  list("Action", ACTION_CHOICES);
  list("Goods Type", GOODS_TYPE_CHOICES);
  list("GST %", GST_CHOICES);

  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 140;
  for (const line of INSTRUCTIONS) info.addRow(line);
  info.getRow(1).font = { bold: true, size: 14 };
  info.getRow(3).font = { bold: true, color: { argb: "FFB45309" } };
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** The GoKesari simple template, as .xlsx bytes. */
export async function buildSimpleTemplate(): Promise<Buffer> {
  return templateWorkbook([], { example: true });
}

const csvQuote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function templateCsv(rows: TemplateRow[]): Buffer {
  const lines = [SIMPLE_TEMPLATE_COLUMNS.map((c) => csvQuote(c)).join(",")];
  for (const row of rows) {
    lines.push(SIMPLE_TEMPLATE_COLUMNS.map((c) => csvQuote(sanitiseCell(row[c] == null ? "" : String(row[c])))).join(","));
  }
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

/** The simple template as CSV: the header and the example row (CSV has no dropdowns or second sheet — see the Excel file's Instructions). */
export function buildSimpleTemplateCsv(): Buffer {
  return templateCsv([EXAMPLE as TemplateRow]);
}

/** A shop's catalogue in the template's layout, ready to edit and upload again (rows match on SKU). */
export async function buildCatalogueWorkbook(rows: TemplateRow[], format: "xlsx" | "csv"): Promise<Buffer> {
  return format === "csv" ? templateCsv(rows) : templateWorkbook(rows, { example: false });
}

/* ------------------------------------------------------------------ report */

export interface ReportInput {
  columns: { label: string; id: string }[];
  rows: { rowNumber: number; raw: Record<string, unknown>; status: string; messages: string[] }[];
}

const STATUS_LABEL: Record<string, string> = {
  ready: "not imported",
  skipped: "skipped",
  created: "created",
  updated: "updated",
  deactivated: "deactivated",
  failed: "failed",
};

/** Rows that did not go in as they were written: failed, skipped, or never imported. */
export const PROBLEM_STATUSES = new Set(["failed", "skipped", "ready"]);

function reportMatrix(input: ReportInput): string[][] {
  const header = ["Row", ...input.columns.map((c) => c.label), "status", "messages"];
  const body = input.rows.map((r) => [
    String(r.rowNumber),
    ...input.columns.map((c) => sanitiseCell(r.raw[c.id] ?? "")),
    STATUS_LABEL[r.status] ?? r.status,
    sanitiseCell(r.messages.join(" | ")),
  ]);
  return [header.map((h) => sanitiseCell(h)), ...body];
}

export function reportCsv(input: ReportInput): Buffer {
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = reportMatrix(input).map((row) => row.map(quote).join(",")).join("\r\n");
  return Buffer.from(`﻿${text}\r\n`, "utf8");
}

export async function reportXlsx(input: ReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Result", { views: [{ state: "frozen", ySplit: 1 }] });
  const matrix = reportMatrix(input);
  for (const row of matrix) ws.addRow(row);
  ws.getRow(1).font = { bold: true };
  const statusCol = matrix[0].length - 1;
  ws.getColumn(statusCol).width = 14;
  ws.getColumn(statusCol + 1).width = 80;
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
