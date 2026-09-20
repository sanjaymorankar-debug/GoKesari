/**
 * Product Master Data Platform - GOKESARI_PRODUCT_MASTER.xlsx.
 * The workbook is written to disk and read BACK, so the assertions are about the real file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dictionaryRows, exportInParts, EXCEL_MAX_ROWS, NOT_AVAILABLE, writeWorkbook } from "@/server/pmd/export/excel";
import { DATA_SHEETS, SHEET_ORDER } from "@/server/pmd/export/model";
import { createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { GTIN, ingest, pmdSql, product, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const dir = mkdtempSync(join(tmpdir(), "pmd-export-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

const mapper = createCategoryMapper({ tags: { "en:milks": "dairy/milk", "en:mobile-phones": "electronics/mobiles/smartphones" }, keywords: [] });

/** A dataset that exercises every sheet: multi-source, multi-seller, price change, conflict, errors, unmatched, missing data. */
async function richData() {
  await ingest("test_brand_feed", [
    product({ sourceProductId: "B1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul", manufacturer: "Gujarat Co-operative Milk Marketing Federation", gtin: GTIN.MILK_1L, categories: ["en:milks"], gstRate: "5%", hsnCode: "0402", images: ["https://img.example.org/milk.jpg"], attributes: [{ key: "ingredients", value: "Toned milk" }, { key: "energy_kcal_per_100g", value: 58 }] }),
    product({ sourceProductId: "B2", name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", gtin: GTIN.PHONE_BLACK, categories: ["en:mobile-phones"], color: "Phantom Black", gstRate: "18%", attributes: [{ key: "ram_gb", value: "8 GB" }, { key: "storage_gb", value: 256 }] }),
  ], { kind: "BRAND_MANUFACTURER", adapterOverride: { categoryMapper: mapper } });
  await ingest("test_market_a", [
    product({ sourceProductId: "A1", name: "AMUL Toned Milk, 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, gstRate: "12%", offer: { sellerName: "Alpha Traders", price: 66, mrp: 68, stock: "in stock", collectedAt: "2026-09-01" } }),
    product({ sourceProductId: "A1", name: "AMUL Toned Milk, 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, gstRate: "12%", offer: { sellerName: "Alpha Traders", price: 64, mrp: 68, stock: "in stock", collectedAt: "2026-09-08" } }),
    product({ sourceProductId: "A1", name: "AMUL Toned Milk, 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, gstRate: "12%", offer: { sellerName: "Beta Stores", price: 67, mrp: 68, stock: "limited", collectedAt: "2026-09-08" } }),
    product({ sourceProductId: "A9", name: "Mystery Item With No Details" }),
    product({ sourceProductId: "A10", name: "" }),
  ]);
  // A held record (GTIN collision) so PRODUCT_SOURCE has an unmatched row.
  await ingest("test_market_b", [product({ sourceProductId: "C1", name: "Toned Milk", brand: "Britannia", gtin: GTIN.MILK_1L })]);
}

async function load(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb;
}

const headerOf = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(String);
const colValues = (ws: ExcelJS.Worksheet, header: string) => {
  const idx = headerOf(ws).indexOf(header) + 1;
  const out: ExcelJS.CellValue[] = [];
  for (let r = 2; r <= ws.rowCount; r++) out.push(ws.getCell(r, idx).value);
  return out;
};

describe("workbook structure", () => {
  it("has the 13 sheets of the brief in the specified order, plus RUN_SUMMARY", async () => {
    await richData();
    const file = join(dir, "structure.xlsx");
    await writeWorkbook(sql, file, { label: "test" });
    const wb = await load(file);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SHEET_ORDER, "RUN_SUMMARY"]);
    expect(SHEET_ORDER).toHaveLength(13);
    expect(SHEET_ORDER[0]).toBe("PRODUCT_MASTER");
    expect(SHEET_ORDER[10]).toBe("DATA_DICTIONARY");
  });

  it("makes every sheet a real Excel table with filters, frozen header, no merged cells, sized columns", async () => {
    await richData();
    const file = join(dir, "tables.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);
    const names = new Set<string>();
    for (const ws of wb.worksheets) {
      const tables = ws.getTables();
      expect(tables.length, `${ws.name} tables`).toBe(1);
      const t = tables[0] as unknown as { table: { name: string; headerRow: boolean; columns: { name: string; filterButton?: boolean }[] } };
      expect(names.has(t.table.name)).toBe(false);
      names.add(t.table.name);
      expect(t.table.headerRow).toBe(true);
      expect(t.table.columns.every((c) => c.name.length > 0)).toBe(true);
      const view = ws.views[0] as { state?: string; ySplit?: number; xSplit?: number };
      expect(view.state, `${ws.name} frozen`).toBe("frozen");
      expect(view.ySplit).toBe(1);
      expect(view.xSplit).toBeGreaterThanOrEqual(1);
      expect((ws.model as { merges?: unknown[] }).merges ?? []).toHaveLength(0);
      expect(ws.getColumn(1).width ?? 0).toBeGreaterThanOrEqual(10);
      // header names are unique within a sheet
      const h = headerOf(ws);
      expect(new Set(h).size).toBe(h.length);
    }
  });

  it("puts one product per row, with unique MASTER_PRODUCT_IDs, and only ACTIVE masters", async () => {
    await richData();
    const file = join(dir, "rows.xlsx");
    await writeWorkbook(sql, file);
    const ws = (await load(file)).getWorksheet("PRODUCT_MASTER")!;
    const ids = colValues(ws, "MASTER_PRODUCT_ID").map(String);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^GKS-PROD-\d{9}$/);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pmd.product_master WHERE record_status = 'ACTIVE'`;
    expect(ids.length).toBe(n);
    // no cell holds several identifiers
    for (const id of ids) expect(id).not.toMatch(/[;,\s]/);
    for (const g of colValues(ws, "GTIN")) if (g !== NOT_AVAILABLE) expect(String(g)).toMatch(/^\d{14}$/);
  });

  it("every child sheet refers only to products that exist in PRODUCT_MASTER", async () => {
    await richData();
    const file = join(dir, "fk.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);
    const ids = new Set(colValues(wb.getWorksheet("PRODUCT_MASTER")!, "MASTER_PRODUCT_ID").map(String));
    for (const name of ["PRODUCT_SPECIFICATIONS", "PRODUCT_SELLER", "PRODUCT_PRICE_HISTORY", "PRODUCT_ATTRIBUTE_CONFLICT", "DATA_QUALITY"]) {
      const ws = wb.getWorksheet(name)!;
      for (const v of colValues(ws, "MASTER_PRODUCT_ID")) if (v != null && v !== NOT_AVAILABLE) expect(ids.has(String(v)), `${name}: ${String(v)}`).toBe(true);
    }
    const src = wb.getWorksheet("PRODUCT_SOURCE")!;
    for (const v of colValues(src, "MASTER_PRODUCT_ID")) if (v !== NOT_AVAILABLE) expect(ids.has(String(v))).toBe(true);
  });
});

describe("workbook content and formatting", () => {
  it("shows missing text as NOT_AVAILABLE and missing numbers as blank - never zero", async () => {
    await richData();
    const file = join(dir, "missing.xlsx");
    await writeWorkbook(sql, file);
    const ws = (await load(file)).getWorksheet("PRODUCT_MASTER")!;
    const names = colValues(ws, "PRODUCT_NAME").map(String);
    const row = names.indexOf("Mystery Item With No Details") + 2;
    const cell = (h: string) => ws.getCell(row, headerOf(ws).indexOf(h) + 1).value;
    expect(cell("GTIN")).toBe(NOT_AVAILABLE);
    expect(cell("BRAND")).toBe(NOT_AVAILABLE);
    expect(cell("GST_RATE")).toBeNull();
    expect(cell("NET_WEIGHT")).toBeNull();
    expect(cell("PACK_COUNT")).toBeNull();
    expect(cell("REFERENCE_MRP")).toBeNull();
    // and it is highlighted by conditional formatting
    expect((ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings.length).toBeGreaterThan(0);
  });

  it("formats dates, timestamps, currency (rupees) and percentages as real Excel values", async () => {
    await richData();
    const file = join(dir, "formats.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);

    const seller = wb.getWorksheet("PRODUCT_SELLER")!;
    const sh = headerOf(seller);
    const alpha = colValues(seller, "SELLER_NAME").indexOf("Alpha Traders") + 2;
    const price = seller.getCell(alpha, sh.indexOf("PRICE") + 1);
    expect(price.value).toBe(64); // minor units 6400 shown as rupees
    expect(price.numFmt).toContain("₹");
    expect(seller.getCell(alpha, sh.indexOf("DISCOUNT_PERCENTAGE") + 1).numFmt).toBe("0.00%");
    const when = seller.getCell(alpha, sh.indexOf("COLLECTION_DATE") + 1);
    expect(when.value).toBeInstanceOf(Date);
    expect(when.numFmt).toBe("yyyy-mm-dd");
    expect(seller.getCell(alpha, sh.indexOf("COLLECTION_TIMESTAMP") + 1).numFmt).toBe("yyyy-mm-dd hh:mm:ss");

    const master = wb.getWorksheet("PRODUCT_MASTER")!;
    const mh = headerOf(master);
    const milk = colValues(master, "PRODUCT_NAME").indexOf("Amul Taaza Toned Milk 1 L") + 2;
    const gst = master.getCell(milk, mh.indexOf("GST_RATE") + 1);
    expect(gst.value).toBeCloseTo(0.05, 6);
    expect(gst.numFmt).toBe("0.00%");
    expect(master.getCell(milk, mh.indexOf("PACK_SIZE") + 1).value).toBe("1000 ml");
  });

  it("derives reference prices from offers and keeps price history append-only in its own sheet", async () => {
    await richData();
    const file = join(dir, "prices.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);
    const master = wb.getWorksheet("PRODUCT_MASTER")!;
    const mh = headerOf(master);
    const row = colValues(master, "PRODUCT_NAME").indexOf("Amul Taaza Toned Milk 1 L") + 2;
    expect(master.getCell(row, mh.indexOf("REFERENCE_PRICE_MIN") + 1).value).toBe(64);
    expect(master.getCell(row, mh.indexOf("REFERENCE_PRICE_MAX") + 1).value).toBe(67);
    expect(master.getCell(row, mh.indexOf("OFFER_COUNT") + 1).value).toBe(2);
    const hist = wb.getWorksheet("PRODUCT_PRICE_HISTORY")!;
    expect(colValues(hist, "SELLING_PRICE").sort()).toEqual([64, 66, 67]);
    expect(colValues(hist, "CHANGE_REASON")).toEqual(expect.arrayContaining(["FIRST_SEEN", "PRICE_CHANGED"]));
  });

  it("applies data validation to status columns and scores", async () => {
    await richData();
    const file = join(dir, "validation.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);
    const master = wb.getWorksheet("PRODUCT_MASTER")!;
    const model = (master as unknown as { dataValidations: { model: Record<string, { type: string; formulae: unknown[] }> } }).dataValidations.model;
    const list = Object.values(model).find((v) => v.type === "list" && String(v.formulae[0]).includes("TEMPORARILY_UNAVAILABLE"));
    const score = Object.values(model).find((v) => v.type === "decimal");
    expect(list).toBeDefined();
    expect(score).toBeDefined();
    const conflicts = (wb.getWorksheet("PRODUCT_ATTRIBUTE_CONFLICT")! as unknown as { dataValidations: { model: Record<string, { formulae: unknown[] }> } }).dataValidations.model;
    expect(Object.values(conflicts).some((v) => String(v.formulae[0]).includes("AUTO_RESOLVED"))).toBe(true);
  });

  it("records conflicts, sources, unmatched records, quality components and import errors", async () => {
    await richData();
    const file = join(dir, "content.xlsx");
    await writeWorkbook(sql, file);
    const wb = await load(file);

    const conflicts = wb.getWorksheet("PRODUCT_ATTRIBUTE_CONFLICT")!;
    expect(colValues(conflicts, "CONFLICT_STATUS")).toContain("AUTO_RESOLVED");
    expect(colValues(conflicts, "SOURCE_1")).toContain("test_brand_feed");

    const src = wb.getWorksheet("PRODUCT_SOURCE")!;
    expect(colValues(src, "MASTER_PRODUCT_ID")).toContain(NOT_AVAILABLE); // the held GTIN-collision record
    expect(colValues(src, "MATCH_STATUS")).toEqual(expect.arrayContaining(["EXACT_MATCH", "NEEDS_REVIEW"]));

    const q = wb.getWorksheet("DATA_QUALITY")!;
    const scores = colValues(q, "DATA_QUALITY_SCORE").map(Number);
    expect(scores.every((s) => s >= 0 && s <= 100)).toBe(true);
    expect(colValues(q, "MISSING_FIELDS").some((v) => String(v).includes("manufacturer"))).toBe(true);

    const errs = wb.getWorksheet("IMPORT_ERRORS")!;
    expect(colValues(errs, "ERROR_CODE")).toContain("NAME_MISSING");
    expect(colValues(errs, "SEVERITY")).toContain("ERROR");
  });

  it("carries the ODbL attribution on RUN_SUMMARY", async () => {
    await richData();
    const file = join(dir, "summary.xlsx");
    await writeWorkbook(sql, file, { label: "PILOT - synthetic test" });
    const ws = (await load(file)).getWorksheet("RUN_SUMMARY")!;
    const text = colValues(ws, "VALUE").map(String).join("\n");
    expect(text).toContain("Open Database Licence");
    expect(text).toContain("PILOT - synthetic test");
    expect(text).toContain("never zero");
  });
});

describe("data dictionary", () => {
  it("defines every column of every data sheet, with its database source", async () => {
    await richData();
    const file = join(dir, "dictionary.xlsx");
    await writeWorkbook(sql, file);
    const ws = (await load(file)).getWorksheet("DATA_DICTIONARY")!;
    const rows = colValues(ws, "SHEET").map(String);
    const expected = DATA_SHEETS.reduce((n, s) => n + s.columns.length, 0);
    expect(rows).toHaveLength(expected);
    expect(dictionaryRows()).toHaveLength(expected);
    for (const sheet of DATA_SHEETS) {
      const fields = new Set<string>();
      colValues(ws, "SHEET").forEach((s, i) => { if (s === sheet.name) fields.add(String(ws.getCell(i + 2, 2).value)); });
      for (const c of sheet.columns) expect(fields.has(c.header), `${sheet.name}.${c.header}`).toBe(true);
    }
    expect(colValues(ws, "DESCRIPTION").every((d) => String(d).length >= 8)).toBe(true);
    expect(colValues(ws, "DATABASE_SOURCE").every((d) => String(d).length > 2)).toBe(true);
  });

  it("covers every field in the brief's product master, description and commercial lists", () => {
    const headers = new Set(DATA_SHEETS.find((s) => s.name === "PRODUCT_MASTER")!.columns.map((c) => c.header));
    for (const h of ["MASTER_PRODUCT_ID", "GTIN", "EAN", "UPC", "ISBN", "SKU", "MPN", "MODEL_NUMBER", "PRODUCT_CODE", "BRAND", "MANUFACTURER",
      "PRODUCT_NAME", "SHORT_DESCRIPTION", "LONG_DESCRIPTION", "PRODUCT_TYPE", "PRODUCT_FAMILY", "VARIANT_NAME", "VARIANT_CODE", "KEY_FEATURES", "SEARCH_KEYWORDS",
      "CATEGORY_LEVEL_1", "CATEGORY_LEVEL_5", "STANDARD_CATEGORY_ID", "SUB_TYPE", "NET_WEIGHT", "GROSS_WEIGHT", "WEIGHT_UNIT", "LENGTH", "WIDTH", "HEIGHT",
      "DIMENSION_UNIT", "VOLUME", "VOLUME_UNIT", "PACK_SIZE", "PACK_COUNT", "UNIT_COUNT", "MATERIAL", "COLOR", "SIZE", "SHAPE", "GST_RATE", "HSN_CODE", "CESS",
      "OTHER_TAXES", "PRIMARY_IMAGE_URL", "IMAGE_URL_1", "IMAGE_URL_5", "IMAGE_SOURCE", "IMAGE_VALIDATION_STATUS", "PRODUCT_STATUS", "DATA_QUALITY_SCORE"]) {
      expect(headers.has(h), h).toBe(true);
    }
  });
});

describe("scale: partitioned export", () => {
  it("refuses to exceed a worksheet's row limit and says how to export instead", async () => {
    await richData();
    await expect(writeWorkbook(sql, join(dir, "limit.xlsx"), { maxRowsPerSheet: 3 })).rejects.toThrow(/exportInParts/);
    expect(EXCEL_MAX_ROWS).toBe(1_048_576);
  });

  it("splits a large master into contiguous parts that together hold every product exactly once", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => product({ sourceProductId: `S${i}`, name: `Split Item ${String.fromCharCode(65 + i)}${i}`, brand: `Brand ${i}`, offer: { sellerName: `Seller ${i}`, price: 10 + i, collectedAt: "2026-09-01" } }));
    await ingest("test_market_a", rows);
    const res = await exportInParts(sql, join(dir, "parts"), { baseName: "SPLIT", productsPerFile: 3 });
    expect(res.length).toBe(3);
    const seen: string[] = [];
    for (const part of res) {
      const wb = await load(part.file);
      const ids = colValues(wb.getWorksheet("PRODUCT_MASTER")!, "MASTER_PRODUCT_ID").map(String);
      seen.push(...ids);
      for (const v of colValues(wb.getWorksheet("PRODUCT_SELLER")!, "MASTER_PRODUCT_ID")) expect(ids).toContain(String(v));
      // dimension sheets repeat in every part
      expect(colValues(wb.getWorksheet("BRAND_MASTER")!, "BRAND_NAME").length).toBe(7);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});
