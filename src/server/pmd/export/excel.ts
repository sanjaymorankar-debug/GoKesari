/**
 * GOKESARI_PRODUCT_MASTER.xlsx builder.
 *
 * Excel is an EXPORT and REPORTING format here, never the system of record
 * (PostgreSQL is). It is generated read-only from the database.
 *
 * Workbook rules (from the brief), all enforced in code and asserted by tests:
 *   - 13 sheets in the specified order (+ a RUN_SUMMARY sheet at the end),
 *   - every sheet is a real Excel TABLE (header row, filter buttons, banded rows),
 *   - frozen header row and leading id columns, auto-sized columns,
 *   - date / currency / percentage number formats; money shown in rupees,
 *   - data validation on status columns and on scores,
 *   - conditional formatting for missing and suspicious data,
 *   - no merged cells, one value per cell, one row per product,
 *   - missing text is NOT_AVAILABLE, missing numbers/dates are blank - never 0.
 *
 * Excel cannot hold more than 1,048,576 rows per sheet, and this platform is designed
 * for 10M products. `exportInParts` therefore writes range-partitioned workbooks.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import type { Sql } from "../db";
import { DATA_SHEETS, SHEET_ORDER, type ColumnDef, type SheetDef, type SheetScope } from "./model";

export const EXCEL_MAX_ROWS = 1_048_576;
export const NOT_AVAILABLE = "NOT_AVAILABLE";
const CELL_TEXT_LIMIT = 32_000; // Excel's hard limit is 32,767 characters per cell

const FILL = {
  amber: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: "FFFFEB9C" }, fgColor: { argb: "FFFFEB9C" } },
  red: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: "FFFFC7CE" }, fgColor: { argb: "FFFFC7CE" } },
  green: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: "FFC6EFCE" }, fgColor: { argb: "FFC6EFCE" } },
};

export interface ExportOptions {
  /** Shown on RUN_SUMMARY, e.g. "PILOT - open data only". */
  label?: string;
  scope?: SheetScope;
  /** Test hook: pretend the sheet limit is lower. */
  maxRowsPerSheet?: number;
  generatedAt?: Date;
}

export interface ExportResult {
  workbook: ExcelJS.Workbook;
  counts: Record<string, number>;
}

/* ------------------------------------------------------------------ cells */

const PERCENT_FROM_BP = new Set(["gst_rate", "cess"]);

export function cellValue(col: ColumnDef, v: unknown): ExcelJS.CellValue {
  if (v == null) return col.type === "text" || col.type === "list" || col.type === "bool" ? NOT_AVAILABLE : null;
  switch (col.type) {
    case "text": {
      const s = String(v);
      return s.length > CELL_TEXT_LIMIT ? `${s.slice(0, CELL_TEXT_LIMIT)}...[truncated]` : s;
    }
    case "int":
    case "number":
      return Number(v);
    case "money":
      return Math.round(Number(v)) / 100; // minor units -> rupees
    case "percent":
      return PERCENT_FROM_BP.has(col.key) ? Number(v) / 10000 : Number(v) / 100;
    case "date": {
      const d = v instanceof Date ? v : new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case "timestamp": {
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case "bool":
      return v ? "Yes" : "No";
    case "list": {
      const items = Array.isArray(v) ? v.filter((x) => x != null && String(x) !== "") : [];
      return items.length ? items.join("; ").slice(0, CELL_TEXT_LIMIT) : NOT_AVAILABLE;
    }
  }
}

export function numberFormat(col: ColumnDef): string | undefined {
  switch (col.type) {
    case "money": return '"₹"#,##0.00';
    case "percent": return "0.00%";
    case "int": return "0";
    case "number": return /score|confidence|rating/.test(col.key) ? "0.00" : "General";
    case "date": return "yyyy-mm-dd";
    case "timestamp": return "yyyy-mm-dd hh:mm:ss";
    default: return undefined;
  }
}

export function columnLetter(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/* ------------------------------------------------------------- one sheet */

/** ExcelJS supports range-based data validation at runtime but does not declare it in its typings. */
type WithValidations = { dataValidations: { add(range: string, validation: unknown): void } };

function addSheet(wb: ExcelJS.Workbook, def: Pick<SheetDef, "name" | "tableName" | "freezeColumns" | "columns">, rows: unknown[][], maxRows: number): number {
  if (rows.length + 1 > maxRows) {
    throw new Error(
      `${def.name} has ${rows.length} rows, more than a worksheet can hold (${maxRows - 1}). ` +
        "Export in parts (exportInParts) - Excel is a reporting format, PostgreSQL is the system of record.",
    );
  }
  const ws = wb.addWorksheet(def.name);
  const headers = def.columns.map((c) => c.header);

  // An Excel table needs at least one data row; an empty result gets one empty row (and RUN_SUMMARY reports 0).
  const data = rows.length ? rows : [def.columns.map(() => null)];
  ws.addTable({
    name: def.tableName,
    ref: "A1",
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: data as ExcelJS.CellValue[][],
  });

  const last = data.length + 1;
  const lastCol = columnLetter(def.columns.length);

  // number formats + auto-size
  def.columns.forEach((col, i) => {
    const fmt = numberFormat(col);
    let width = col.header.length;
    for (let r = 0; r < Math.min(data.length, 600); r++) {
      const v = data[r][i];
      const len = v instanceof Date ? 19 : v == null ? 0 : String(v).length;
      if (len > width) width = len;
    }
    ws.getColumn(i + 1).width = Math.max(col.width ?? 0, Math.min(Math.max(width + 2, 10), 60));
    if (fmt) for (let r = 2; r <= last; r++) ws.getCell(r, i + 1).numFmt = fmt;
  });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle", wrapText: false };

  ws.views = [{ state: "frozen", xSplit: def.freezeColumns, ySplit: 1, topLeftCell: `${columnLetter(def.freezeColumns + 1)}2`, activeCell: `${columnLetter(def.freezeColumns + 1)}2` }];

  // data validation on constrained columns and on scores
  def.columns.forEach((col, i) => {
    const letter = columnLetter(i + 1);
    const ref = `${letter}2:${letter}${last}`;
    if (col.allowed?.length) {
      (ws as unknown as WithValidations).dataValidations.add(ref, {
        type: "list",
        allowBlank: true,
        formulae: [`"${col.allowed.join(",")}"`],
        showErrorMessage: true,
        errorTitle: col.header,
        error: `Allowed: ${col.allowed.join(", ")}`,
      });
    } else if (/^(data_quality_score|.*_score|match_score|confidence|data_confidence)$/.test(col.key)) {
      (ws as unknown as WithValidations).dataValidations.add(ref, {
        type: "decimal", operator: "between", formulae: [0, 100], allowBlank: true, showErrorMessage: true, errorTitle: col.header, error: "Scores are between 0 and 100.",
      });
    }
  });

  // conditional formatting: missing and suspicious data
  const whole = `A2:${lastCol}${last}`;
  ws.addConditionalFormatting({
    ref: whole,
    rules: [{ type: "containsText", operator: "containsText", text: NOT_AVAILABLE, style: { fill: FILL.amber }, priority: 1 }],
  });
  def.columns.forEach((col, i) => {
    const letter = columnLetter(i + 1);
    const ref = `${letter}2:${letter}${last}`;
    if (col.key === "data_quality_score") {
      ws.addConditionalFormatting({
        ref,
        rules: [
          { type: "cellIs", operator: "lessThan", formulae: [50], style: { fill: FILL.red }, priority: 2 },
          { type: "cellIs", operator: "greaterThan", formulae: [74.99], style: { fill: FILL.green }, priority: 3 },
        ],
      });
    } else if (["open_conflict_count", "open_conflicts", "pending_review_items"].includes(col.key)) {
      ws.addConditionalFormatting({ ref, rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], style: { fill: FILL.red }, priority: 4 }] });
    } else if (col.key === "conflict_status") {
      ws.addConditionalFormatting({ ref, rules: [{ type: "containsText", operator: "containsText", text: "OPEN", style: { fill: FILL.red }, priority: 5 }] });
    } else if (col.key === "severity") {
      ws.addConditionalFormatting({ ref, rules: [{ type: "containsText", operator: "containsText", text: "ERROR", style: { fill: FILL.red }, priority: 6 }] });
    } else if (col.key === "match_status") {
      ws.addConditionalFormatting({
        ref,
        rules: [
          { type: "containsText", operator: "containsText", text: "NEEDS_REVIEW", style: { fill: FILL.red }, priority: 7 },
          { type: "containsText", operator: "containsText", text: "POSSIBLE_MATCH", style: { fill: FILL.amber }, priority: 8 },
        ],
      });
    } else if (col.key === "product_status") {
      ws.addConditionalFormatting({ ref, rules: [{ type: "containsText", operator: "containsText", text: "UNAVAILABLE", style: { fill: FILL.amber }, priority: 9 }] });
    } else if (col.required && ["int", "number", "money", "percent", "date", "timestamp"].includes(col.type)) {
      // a required numeric/date field left blank
      ws.addConditionalFormatting({ ref, rules: [{ type: "expression", formulae: [`ISBLANK(${letter}2)`], style: { fill: FILL.amber }, priority: 10 }] });
    }
  });
  return rows.length;
}

/* ------------------------------------------------------------- dictionary */

const TYPE_LABEL: Record<ColumnDef["type"], string> = {
  text: "Text", int: "Integer", number: "Number", date: "Date (yyyy-mm-dd)", timestamp: "Timestamp UTC (yyyy-mm-dd hh:mm:ss)",
  money: "Currency (rupees)", percent: "Percentage", bool: "Yes / No", list: "List (values separated by '; ')",
};

export const DICTIONARY_COLUMNS: ColumnDef[] = [
  { key: "sheet", header: "SHEET", type: "text", source: "export model", description: "Worksheet name.", required: true },
  { key: "field", header: "FIELD", type: "text", source: "export model", description: "Column header as it appears in the sheet.", required: true, width: 28 },
  { key: "data_type", header: "DATA_TYPE", type: "text", source: "export model", description: "How values are stored and formatted.", width: 30 },
  { key: "required", header: "REQUIRED", type: "text", source: "export model", description: "Yes when the field should be present wherever the data exists; blanks are then highlighted.", allowed: ["Yes", "No"] },
  { key: "derived", header: "DERIVED", type: "text", source: "export model", description: "Yes when computed for the export and not stored on the record.", allowed: ["Yes", "No"] },
  { key: "missing_value", header: "MISSING_VALUE", type: "text", source: "export model", description: "How a missing value is shown: NOT_AVAILABLE for text, blank for numbers and dates. Never 0." },
  { key: "allowed_values", header: "ALLOWED_VALUES", type: "text", source: "export model", description: "Enumerated values (also enforced by Excel data validation).", width: 40 },
  { key: "database_source", header: "DATABASE_SOURCE", type: "text", source: "export model", description: "Table.column or derivation in the PostgreSQL schema.", width: 46 },
  { key: "description", header: "DESCRIPTION", type: "text", source: "export model", description: "What the field means.", width: 70 },
];

export function dictionaryRows(): unknown[][] {
  const rows: unknown[][] = [];
  const sheets = [...DATA_SHEETS];
  for (const name of SHEET_ORDER) {
    const def = sheets.find((s) => s.name === name);
    if (!def) continue;
    for (const c of def.columns) {
      rows.push([
        def.name, c.header, TYPE_LABEL[c.type], c.required ? "Yes" : "No", c.derived ? "Yes" : "No",
        c.type === "text" || c.type === "list" || c.type === "bool" ? NOT_AVAILABLE : "(blank)", c.allowed?.join(", ") ?? null, c.source, c.description,
      ]);
    }
  }
  return rows;
}

/* --------------------------------------------------------------- workbook */

const LICENSE_LINES = [
  "Contains information from Open Food Facts, Open Beauty Facts, Open Products Facts, Open Pet Food Facts and Open Prices, made available under the Open Database Licence (ODbL) 1.0; individual contents under the Database Contents Licence (DbCL) 1.0. Attribution: Open Food Facts contributors. Derived databases must stay under the same terms.",
  "Product images are referenced by URL only (CC BY-SA, by their contributors); no image is copied or redistributed.",
];

export async function buildWorkbook(sql: Sql, opts: ExportOptions = {}): Promise<ExportResult> {
  const maxRows = opts.maxRowsPerSheet ?? EXCEL_MAX_ROWS;
  const scope = opts.scope ?? {};
  const generatedAt = opts.generatedAt ?? new Date();
  const wb = new ExcelJS.Workbook();
  wb.creator = "Gokesari Product Master Data Platform";
  wb.title = "GOKESARI_PRODUCT_MASTER";
  wb.subject = opts.label ?? "Product master export";
  wb.created = generatedAt;
  wb.modified = generatedAt;

  const counts: Record<string, number> = {};
  const byName = new Map<string, SheetDef>(DATA_SHEETS.map((s) => [s.name, s]));

  for (const name of SHEET_ORDER) {
    if (name === "DATA_DICTIONARY") {
      const dict = dictionaryRows();
      counts[name] = addSheet(wb, { name, tableName: "tblDataDictionary", freezeColumns: 2, columns: DICTIONARY_COLUMNS }, dict, maxRows);
      continue;
    }
    const def = byName.get(name)!;
    const raw = await sql.unsafe<Record<string, unknown>[]>(def.query(scope));
    const rows = raw.map((r) => def.columns.map((c) => cellValue(c, r[c.key])));
    counts[name] = addSheet(wb, def, rows, maxRows);
  }

  // RUN_SUMMARY: provenance, counts, and what the blanks mean.
  const [{ migration }] = await sql<{ migration: string | null }[]>`SELECT (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations) AS migration`.catch(() => [{ migration: null }]);
  const metrics = await sql<{ metric: string; dimension: string; value: number }[]>`SELECT metric, dimension, value FROM pmd.dashboard_metric WHERE dimension = '' ORDER BY metric`.catch(() => []);
  const summary: unknown[][] = [
    ["Generated at (UTC)", generatedAt.toISOString()],
    ["Label", opts.label ?? "Product master export"],
    ["Scope", scope.fromProductId != null || scope.toProductId != null ? `product ids ${scope.fromProductId ?? "start"} to ${scope.toProductId ?? "end"}` : "all ACTIVE products"],
    ["Schema", `pmd (migration 0015_product_master_platform; last applied ${migration ?? "unknown"})`],
    ...Object.entries(counts).map(([k, v]) => [`Rows: ${k}`, String(v)]),
    ...metrics.map((m) => [`Dashboard: ${m.metric}`, String(m.value)]),
    ["Missing values", "Text fields show NOT_AVAILABLE; numeric and date fields are blank. Missing data is never zero."],
    ["Prices", "MRP and selling price are per offer and per date (PRODUCT_SELLER, PRODUCT_PRICE_HISTORY). PRODUCT_MASTER.REFERENCE_* columns are derived views of current offers."],
    ["Status", "DISCONTINUED is never set because a single marketplace stopped listing a product."],
    ...LICENSE_LINES.map((l, i) => [`Licence / attribution ${i + 1}`, l]),
  ];
  addSheet(
    wb,
    {
      name: "RUN_SUMMARY", tableName: "tblRunSummary", freezeColumns: 1,
      columns: [
        { key: "item", header: "ITEM", type: "text", source: "", description: "", width: 32 },
        { key: "value", header: "VALUE", type: "text", source: "", description: "", width: 110 },
      ],
    },
    summary,
    maxRows,
  );
  return { workbook: wb, counts };
}

export async function writeWorkbook(sql: Sql, file: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const res = await buildWorkbook(sql, opts);
  await res.workbook.xlsx.writeFile(file);
  return res;
}

export interface PartResult {
  file: string;
  fromProductId: number;
  toProductId: number;
  counts: Record<string, number>;
}

/**
 * Range-partitioned export for datasets beyond one workbook. Each part carries a contiguous
 * product-id range together with all of that range's specifications, sources, offers,
 * history and conflicts; the dimension sheets (brands, categories...) repeat in every part.
 */
export async function exportInParts(
  sql: Sql,
  dir: string,
  opts: ExportOptions & { baseName?: string; productsPerFile?: number } = {},
): Promise<PartResult[]> {
  mkdirSync(dir, { recursive: true });
  const per = opts.productsPerFile ?? 50_000;
  const baseName = opts.baseName ?? "GOKESARI_PRODUCT_MASTER";
  const [{ lo, hi, n }] = await sql<{ lo: number | null; hi: number | null; n: number }[]>`
    SELECT min(product_id) AS lo, max(product_id) AS hi, count(*)::int AS n FROM pmd.product_master WHERE record_status = 'ACTIVE'`;

  const parts: PartResult[] = [];
  if (lo == null || hi == null || n <= per) {
    const file = join(dir, `${baseName}.xlsx`);
    const res = await writeWorkbook(sql, file, opts);
    return [{ file, fromProductId: lo ?? 0, toProductId: hi ?? 0, counts: res.counts }];
  }

  // Split by product count, not id span, so parts are even even when ids have gaps.
  const bounds = await sql<{ product_id: number }[]>`
    SELECT product_id FROM (SELECT product_id, row_number() OVER (ORDER BY product_id) AS rn FROM pmd.product_master WHERE record_status = 'ACTIVE') t
    WHERE rn % ${per} = 1 ORDER BY product_id`;
  for (let i = 0; i < bounds.length; i++) {
    const from = bounds[i].product_id;
    const to = i + 1 < bounds.length ? bounds[i + 1].product_id - 1 : hi;
    const file = join(dir, `${baseName}_part${String(i + 1).padStart(3, "0")}.xlsx`);
    const res = await writeWorkbook(sql, file, { ...opts, label: `${opts.label ?? "Product master export"} (part ${i + 1} of ${bounds.length})`, scope: { fromProductId: from, toProductId: to } });
    parts.push({ file, fromProductId: from, toProductId: to, counts: res.counts });
  }
  return parts;
}
