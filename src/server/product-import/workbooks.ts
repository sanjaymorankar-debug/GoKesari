/**
 * Files the bulk product upload hands out (docs/product-import-2026-10):
 *   - the GoKesari simple template (GoKesari_Product_Upload_Template.xlsx);
 *   - the result report: the uploaded rows with `status` and `messages` added,
 *     as CSV or XLSX.
 * Every value written into a generated sheet is defanged against formula
 * injection (a cell starting = + - @ is prefixed with ').
 */
import ExcelJS from "exceljs";

import { ROW_ERROR_PREFIX } from "@/lib/product-import";
import { STANDARD_GST_RATES } from "@/server/gst/product-rates";
import { sanitiseCell } from "@/server/services/excel";

export const TEMPLATE_FILE_NAME = "GoKesari_Product_Upload_Template.xlsx";
export const TEMPLATE_CSV_FILE_NAME = "GoKesari_Product_Upload_Template.csv";

/**
 * The simple template's columns, in order (§6). The four mandatory ones come
 * first (owner, 08 Nov 2026); "GoKesari Product ID" is last, hidden and locked
 * — filled by "Download my catalogue" so a re-uploaded row finds its product
 * even when the SKU was changed.
 */
export const SIMPLE_TEMPLATE_COLUMNS = [
  "Product Name", "Category", "Sub-category", "Brand", "MRP", "Selling Price", "Stock Qty", "Unit", "Pack Size",
  "Loose Item (Y/N)", "SKU", "Barcode Type", "Barcode", "HSN Code", "GST %", "Description", "Main Image URL",
  "Manufacturer", "Sale Price", "Sale Start", "Sale End", "Color", "Size", "Material",
  "Highlight 1", "Highlight 2", "Highlight 3", "Highlight 4", "Highlight 5", "Keywords",
  "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5", "Weight (g)", "Length (cm)", "Width (cm)", "Height (cm)",
  "Country of Origin", "Max Order Qty", "Action", "GoKesari Product ID",
] as const;

type TemplateColumn = (typeof SIMPLE_TEMPLATE_COLUMNS)[number];

/** Every row needs these (MRP not for a loose item); an Action = Delete row needs only its SKU. */
export const MANDATORY_COLUMNS: readonly TemplateColumn[] = ["Product Name", "Category", "MRP", "Stock Qty"];

export const BARCODE_TYPE_CHOICES = ["EAN", "UPC", "GTIN", "ISBN", "ASIN", "GTIN Exempt", "Other"];
export const UNIT_CHOICES = ["pcs", "kg", "g", "l", "ml", "pack"];
export const ACTION_CHOICES = ["Upsert", "Edit", "Delete"];
export const LOOSE_CHOICES = ["N", "Y"];
export const GST_CHOICES = STANDARD_GST_RATES.map(String);

/** The category master the template's dropdowns are filled from. */
export interface TemplateLists {
  categories: string[];
  subcategories: { category: string; name: string }[];
}

const EXAMPLE_MARK = "EXAMPLE – delete this row";

/** Sample rows, each marked in its SKU cell: the upload leaves them out. */
const EXAMPLES: Partial<Record<TemplateColumn, string | number>>[] = [
  {
    "Product Name": "Amul Gold Full Cream Milk 500 ml",
    Category: "Milk",
    Brand: "Amul",
    MRP: 34,
    "Selling Price": 33,
    "Stock Qty": 50,
    Unit: "pack",
    "Pack Size": "500 ml",
    "Loose Item (Y/N)": "N",
    SKU: EXAMPLE_MARK,
    "Barcode Type": "EAN",
    Barcode: "8901262010016",
    "HSN Code": "04012000",
    "GST %": 0,
    Description: "Full cream milk, pasteurised and homogenised.",
    "Main Image URL": "https://example.com/images/amul-gold-500ml.jpg",
    Manufacturer: "Gujarat Cooperative Milk Marketing Federation",
    "Highlight 1": "6% fat",
    Keywords: "milk full cream amul gold",
    "Weight (g)": 520,
    "Country of Origin": "India",
    "Max Order Qty": 10,
    Action: "Upsert",
  },
  {
    "Product Name": "साखर (Sugar)",
    Category: "Sugar",
    Unit: "kg",
    "Stock Qty": 25.5,
    "Selling Price": 46,
    "Loose Item (Y/N)": "Y",
    SKU: EXAMPLE_MARK,
    "HSN Code": "1701",
    "GST %": 5,
    Description: "Loose sugar, sold by weight. A loose item needs no MRP; its price may be left empty.",
  },
  {
    "Product Name": "Parle-G Biscuits 250 g",
    Category: "Biscuits",
    Brand: "Parle",
    MRP: 30,
    "Selling Price": 28,
    "Stock Qty": 120,
    Unit: "pack",
    "Pack Size": "250 g",
    "Loose Item (Y/N)": "N",
    SKU: EXAMPLE_MARK,
    "HSN Code": "1905",
    "GST %": 18,
  },
];

const INSTRUCTIONS: string[][] = [
  ["GoKesari bulk product upload — instructions"],
  [""],
  ["MANDATORY on every row: Product Name, Category, MRP (not for a loose item) and Stock Qty. Their headings are dark orange."],
  ["A row without them, or with a wrong value (below), is NOT imported: the preview lists it as 'Row 14: MRP missing' and you can download the rows to fix with an Error column."],
  ["The other rows of the file are still imported. Fix the error rows and upload them again."],
  ["An Action = Delete row needs only its SKU."],
  [""],
  ["Column", "Mandatory?", "What to enter", "Example"],
  ["Product Name", "Yes", "The product's name. Hindi and Marathi are fine.", "Amul Gold Full Cream Milk 500 ml"],
  ["Category", "Yes", "Choose from the list (the GoKesari category master). A name not on the list is an error.", "Milk"],
  ["Sub-category", "No", "Choose from the list; it must belong to the Category. Otherwise it is left empty (a warning).", ""],
  ["Brand", "No", "The brand name.", "Amul"],
  ["MRP", "Yes, except a loose item", "Maximum retail price in rupees, 0 or more. ₹1,299.00, 1299 and 1,299 all work. A loose item has no MRP.", "34"],
  ["Selling Price", "No", "Your price in rupees, more than 0 and not above the MRP. A loose item may leave it empty.", "33"],
  ["Stock Qty", "Yes", "Your stock: 0 or more. Up to 3 decimals for a loose item (2.5 kg). On the upload screen choose 'Set stock to file quantity' (default) or 'Add file quantity to current stock'.", "50"],
  ["Unit", "No", "pcs, kg, g, l, ml or pack. A loose item needs kg, g, l or ml.", "pack"],
  ["Pack Size", "No", "The pack size, e.g. 500 ml or 1 kg. Used with the name to find a product you already have.", "500 ml"],
  ["Loose Item (Y/N)", "No", "Y = sold loose by weight or volume (no MRP); N or blank = packaged.", "N"],
  ["SKU", "No", "Your own code for the product. No SKU? One is made for you (GK-…).", "MILK-500"],
  ["Barcode Type / Barcode", "No", "EAN, UPC, GTIN, ISBN… and the barcode digits. Matched against the GoKesari catalogue.", "EAN / 8901262010016"],
  ["HSN Code", "No", "4, 6 or 8 digits.", "04012000"],
  ["GST %", "No", `Choose from the list (${STANDARD_GST_RATES.join(", ")}). Any other rate is an error.`, "5"],
  ["Description", "No", "A few lines about the product.", ""],
  ["Main Image URL, Image URL 2–5", "No", "http or https links to JPG, PNG or WebP files, up to 5 MB each. They are downloaded after the import.", "https://…"],
  ["Sale Price / Sale Start / Sale End", "No", "A sale price (not above the MRP) and its dates, dd/mm/yyyy.", ""],
  ["Action", "No", "Upsert (add or update — the default), Edit (update only; a row that matches nothing is skipped), Delete (hides the product from customers and sets its stock to 0).", "Upsert"],
  ["GoKesari Product ID", "No (hidden)", "Filled by 'Download my catalogue'. Leave it as it is.", ""],
  [""],
  ["How a row finds your product (so a re-upload updates, never duplicates):"],
  ["  1. GoKesari Product ID or SKU — a product already in your shop."],
  ["  2. Barcode — matched against the GoKesari catalogue."],
  ["  3. Product Name + Brand (+ Size or Pack Size / Color) — an exact match in the catalogue."],
  ["  4. Nothing matched — a new product is added (waiting for approval in the catalogue) and you can sell it in your shop straight away."],
  ["The same SKU twice in one file: the rows are merged and the last row wins."],
  ["MRP and Selling Price apply to your shop only; the GoKesari catalogue is never changed by your file."],
  ["To change many prices or stock at once: 'Download my products' on the upload screen, edit the file, and upload it again."],
  [""],
  ["Rows 2–4 of the Products sheet are examples marked 'EXAMPLE – delete this row'. Delete them or leave them — they are never imported."],
  ["Blank rows, extra columns and columns in another order are fine: columns are found by their heading."],
  ["Amazon Seller Central inventory files (.xlsm / .xlsx) can be uploaded as they are, without copying into this template."],
];

export type TemplateRow = Partial<Record<TemplateColumn, string | number | null>>;

const DEFAULT_LISTS: TemplateLists = { categories: [], subcategories: [] };

/** A workbook in the simple template's layout — dropdowns and the Instructions sheet included — holding `rows`. */
async function templateWorkbook(rows: TemplateRow[], options: { example: boolean; lists?: TemplateLists }): Promise<Buffer> {
  const lists = options.lists ?? DEFAULT_LISTS;
  const wb = new ExcelJS.Workbook();
  wb.creator = "GoKesari";
  const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = SIMPLE_TEMPLATE_COLUMNS.map((header) => ({ header, key: header, width: Math.max(12, header.length + 4) }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.eachCell((cell, n) => {
    const mandatory = MANDATORY_COLUMNS.includes(SIMPLE_TEMPLATE_COLUMNS[n - 1]);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: mandatory ? "FFF59E0B" : "FFFDE7C7" } };
    if (mandatory) cell.note = SIMPLE_TEMPLATE_COLUMNS[n - 1] === "MRP" ? "Mandatory (not for a loose item)" : "Mandatory";
  });
  if (options.example) {
    for (const ex of EXAMPLES) {
      const example = ws.addRow(SIMPLE_TEMPLATE_COLUMNS.map((c) => ex[c] ?? null));
      example.font = { italic: true, color: { argb: "FF8A6D3B" } };
    }
  }
  for (const row of rows) {
    ws.addRow(SIMPLE_TEMPLATE_COLUMNS.map((c) => {
      const v = row[c];
      return typeof v === "string" ? sanitiseCell(v) : (v ?? null);
    }));
  }
  const lastRow = Math.max(5001, rows.length + 1001);

  const col = (name: TemplateColumn) => ws.getColumn(SIMPLE_TEMPLATE_COLUMNS.indexOf(name) + 1);
  // ExcelJS supports range validations at runtime; its type definitions omit them.
  const validations = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
  const listFrom = (name: TemplateColumn, formula: string, choices: string, strict = false) =>
    validations.add(`${col(name).letter}2:${col(name).letter}${lastRow}`, {
      type: "list",
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorStyle: strict ? "stop" : "warning",
      errorTitle: name,
      error: `Choose one of: ${choices}`,
    });
  const list = (name: TemplateColumn, choices: string[], strict = false) => listFrom(name, `"${choices.join(",")}"`, choices.join(", "), strict);
  list("Barcode Type", BARCODE_TYPE_CHOICES);
  list("Unit", UNIT_CHOICES);
  list("Action", ACTION_CHOICES);
  list("Loose Item (Y/N)", LOOSE_CHOICES);
  list("GST %", GST_CHOICES);

  // Category and Sub-category from the master data, on a hidden sheet (an inline list is limited to 255 characters).
  const listSheet = wb.addWorksheet("Lists", { state: "veryHidden" });
  listSheet.getCell(1, 1).value = "Category";
  listSheet.getCell(1, 2).value = "Sub-category";
  listSheet.getCell(1, 3).value = "Of category";
  lists.categories.forEach((c, i) => (listSheet.getCell(i + 2, 1).value = sanitiseCell(c)));
  lists.subcategories.forEach((s, i) => {
    listSheet.getCell(i + 2, 2).value = sanitiseCell(s.name);
    listSheet.getCell(i + 2, 3).value = sanitiseCell(s.category);
  });
  if (lists.categories.length) {
    listFrom("Category", `Lists!$A$2:$A$${lists.categories.length + 1}`, "a category from the list");
  }
  if (lists.subcategories.length) {
    listFrom("Sub-category", `Lists!$B$2:$B$${lists.subcategories.length + 1}`, "a sub-category from the list");
  }

  // The product ID is for matching only: hidden, and locked against editing (the sheet is protected without a password).
  const idCol = col("GoKesari Product ID");
  idCol.hidden = true;
  ws.columns.forEach((c) => {
    if (c !== idCol) c.protection = { locked: false };
  });
  idCol.protection = { locked: true };
  await ws.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: true,
    formatColumns: true,
    formatRows: true,
    insertColumns: true,
    insertRows: true,
    deleteRows: true,
    sort: true,
    autoFilter: true,
  });

  const info = wb.addWorksheet("Instructions");
  info.getColumn(1).width = 34;
  info.getColumn(2).width = 24;
  info.getColumn(3).width = 110;
  info.getColumn(4).width = 34;
  for (const line of INSTRUCTIONS) info.addRow(line);
  info.getRow(1).font = { bold: true, size: 14 };
  info.getRow(3).font = { bold: true, color: { argb: "FFB45309" } };
  info.getRow(8).font = { bold: true };
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** The GoKesari simple template, as .xlsx bytes, with the category master's dropdowns. */
export async function buildSimpleTemplate(lists?: TemplateLists): Promise<Buffer> {
  return templateWorkbook([], { example: true, lists });
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
  return templateCsv(EXAMPLES as TemplateRow[]);
}

/** A shop's catalogue in the template's layout, ready to edit and upload again (rows match on SKU). */
export async function buildCatalogueWorkbook(rows: TemplateRow[], format: "xlsx" | "csv", lists?: TemplateLists): Promise<Buffer> {
  return format === "csv" ? templateCsv(rows) : templateWorkbook(rows, { example: false, lists });
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
  const header = ["Row", ...input.columns.map((c) => c.label), "Error", "status", "messages"];
  const body = input.rows.map((r) => {
    const errors = r.messages.filter((m) => m.startsWith(ROW_ERROR_PREFIX)).map((m) => m.slice(ROW_ERROR_PREFIX.length));
    const rejected = errors.length > 0;
    return [
      String(r.rowNumber),
      ...input.columns.map((c) => sanitiseCell(r.raw[c.id] ?? "")),
      sanitiseCell(errors.join(" | ")),
      rejected ? "error – not imported" : (STATUS_LABEL[r.status] ?? r.status),
      sanitiseCell(r.messages.filter((m) => !m.startsWith(ROW_ERROR_PREFIX)).join(" | ")),
    ];
  });
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
  ws.getColumn(statusCol - 1).width = 60;
  ws.getColumn(statusCol - 1).font = { color: { argb: "FFB91C1C" } };
  ws.getColumn(statusCol).width = 20;
  ws.getColumn(statusCol + 1).width = 80;
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
