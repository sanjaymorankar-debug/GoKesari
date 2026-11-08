/**
 * Bulk product upload, 08 Nov 2026 brief (docs/product-import-2026-10 §10):
 * mandatory columns and row errors, the Category / Sub-category dropdowns
 * from the master, Loose Item (Y/N), the sample rows, the hidden GoKesari
 * Product ID, the Error column of the report, and Hindi / Marathi names.
 * No database.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { CatalogueMatcher } from "@/server/product-import/matcher";
import { matchKey } from "@/server/product-import/normalise";
import { parseImportFile } from "@/server/product-import/parse";
import { rowErrors } from "@/server/product-import/preview-checks";
import {
  buildCatalogueWorkbook,
  buildSimpleTemplate,
  MANDATORY_COLUMNS,
  reportXlsx,
  SIMPLE_TEMPLATE_COLUMNS,
} from "@/server/product-import/workbooks";

const LISTS = {
  categories: ["Biscuits", "Milk", "Sugar"],
  subcategories: [
    { category: "Milk", name: "Full Cream" },
    { category: "Milk", name: "Toned" },
  ],
};

async function load(bytes: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return wb;
}

function csv(lines: string[]): Buffer {
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

describe("TC-PT-01 template layout", () => {
  it("puts the brief's columns first and marks the four mandatory ones", async () => {
    expect(SIMPLE_TEMPLATE_COLUMNS.slice(0, 10)).toEqual([
      "Product Name", "Category", "Sub-category", "Brand", "MRP", "Selling Price", "Stock Qty", "Unit", "Pack Size", "Loose Item (Y/N)",
    ]);
    for (const c of ["SKU", "Barcode", "HSN Code", "GST %", "Description", "Main Image URL"]) expect(SIMPLE_TEMPLATE_COLUMNS).toContain(c);
    expect(MANDATORY_COLUMNS).toEqual(["Product Name", "Category", "MRP", "Stock Qty"]);

    const wb = await load(await buildSimpleTemplate(LISTS));
    const ws = wb.getWorksheet("Products")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.getRow(1).font?.bold).toBe(true);
    const head = (c: string) => ws.getCell(1, SIMPLE_TEMPLATE_COLUMNS.indexOf(c as (typeof SIMPLE_TEMPLATE_COLUMNS)[number]) + 1);
    expect(head("MRP").note).toBeTruthy();
    expect(head("Brand").note).toBeFalsy();
  });

  it("fills Category and Sub-category dropdowns from the master, on a hidden Lists sheet", async () => {
    const wb = await load(await buildSimpleTemplate(LISTS));
    const lists = wb.getWorksheet("Lists")!;
    expect(lists.state).toBe("veryHidden");
    expect([2, 3, 4].map((r) => lists.getCell(r, 1).value)).toEqual(["Biscuits", "Milk", "Sugar"]);
    expect([2, 3].map((r) => lists.getCell(r, 2).value)).toEqual(["Full Cream", "Toned"]);
    const ws = wb.getWorksheet("Products")!;
    const at = (c: string) => ws.getCell(5, SIMPLE_TEMPLATE_COLUMNS.indexOf(c as (typeof SIMPLE_TEMPLATE_COLUMNS)[number]) + 1).dataValidation;
    expect(at("Category")).toMatchObject({ type: "list", formulae: ["Lists!$A$2:$A$4"] });
    expect(at("Sub-category")).toMatchObject({ type: "list", formulae: ["Lists!$B$2:$B$3"] });
    expect(at("GST %")).toMatchObject({ type: "list" });
    expect(at("Loose Item (Y/N)").formulae?.[0]).toBe('"N,Y"');
  });

  it("has three sample rows that are never imported, and an Instructions sheet with a row per column", async () => {
    const bytes = await buildSimpleTemplate(LISTS);
    const parsed = await parseImportFile(bytes, "GoKesari_Product_Upload_Template.xlsx", { maxRows: 10 });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.skippedTemplateRows).toEqual([2, 3, 4]);
    const info = (await load(bytes)).getWorksheet("Instructions")!;
    const firstCells: string[] = [];
    info.eachRow((row) => firstCells.push(String(row.getCell(1).value ?? "")));
    for (const c of ["Product Name", "Category", "MRP", "Stock Qty", "Loose Item (Y/N)", "GST %"]) expect(firstCells).toContain(c);
  });

  it("hides and locks the GoKesari Product ID column; every other column stays editable", async () => {
    const bytes = await buildCatalogueWorkbook([{ SKU: "MILK-1", "Product Name": "Milk", "GoKesari Product ID": "P00012" }], "xlsx", LISTS);
    const ws = (await load(bytes)).getWorksheet("Products")!;
    const idCol = SIMPLE_TEMPLATE_COLUMNS.indexOf("GoKesari Product ID") + 1;
    expect(ws.getColumn(idCol).hidden).toBe(true);
    expect(ws.getCell(2, idCol).value).toBe("P00012");
    expect(ws.getCell(2, idCol).protection?.locked).not.toBe(false);
    expect(ws.getCell(2, 1).protection?.locked).toBe(false);
    expect(ws.getCell(50, 1).protection?.locked ?? ws.getColumn(1).protection?.locked).toBe(false);
    expect((ws as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet).toBe(true);
  });
});

describe("TC-PT-02 row errors (mandatory on every row, owner 08 Nov 2026)", () => {
  const good = { name: "Amul Milk", category: "Milk", mrpPaise: 3_400, pricePaise: 3_300, quantity: 10 };

  it("accepts a complete row", () => {
    expect(rowErrors(good, { categoryKnown: true })).toEqual([]);
  });

  it("names each missing mandatory column", () => {
    expect(rowErrors({ ...good, name: undefined })).toEqual(["Product Name missing"]);
    expect(rowErrors({ ...good, category: undefined })).toEqual(["Category missing"]);
    expect(rowErrors({ ...good, mrpPaise: undefined, pricePaise: undefined })).toEqual(["MRP missing"]);
    expect(rowErrors({ ...good, quantity: undefined })).toEqual(["Stock Qty missing"]);
    expect(rowErrors({})).toEqual(["Product Name missing", "Category missing", "MRP missing", "Stock Qty missing"]);
  });

  it("a loose item needs no MRP and may have no price", () => {
    expect(rowErrors({ name: "Sugar", category: "Sugar", goodsKind: "LOOSE", quantity: 2.5 })).toEqual([]);
  });

  it("rejects a selling or sale price above the MRP, and unreadable or negative numbers", () => {
    expect(rowErrors({ ...good, pricePaise: 3_500 })).toEqual(["Selling Price ₹35.00 > MRP ₹34.00"]);
    expect(rowErrors({ ...good, salePricePaise: 3_500 })).toEqual(["Sale Price ₹35.00 > MRP ₹34.00"]);
    expect(rowErrors({ ...good, mrpPaise: undefined, invalidValues: { mrp: "-5" } })).toEqual(['MRP "-5" is not a valid amount (a number, 0 or more)']);
    expect(rowErrors({ ...good, quantity: undefined, quantityInvalid: "-3" })).toEqual(['Stock Qty "-3" is not a valid quantity (a number, 0 or more)']);
    expect(rowErrors({ ...good, invalidValues: { gstPercent: "abc" } })).toEqual(['GST % "abc" is not a valid GST rate']);
  });

  it("rejects a Category that is not in the master; Amazon browse nodes keep their General fallback", () => {
    expect(rowErrors({ ...good, category: "Toys" }, { categoryKnown: false })).toEqual(['Invalid category "Toys" — choose one from the Category list']);
    expect(rowErrors({ ...good, category: undefined, categoryHints: ["Jigsaw Puzzles"] }, { categoryKnown: undefined })).toEqual([]);
  });

  it("a Delete row needs only its SKU", () => {
    expect(rowErrors({ sku: "X-1", action: "DELETE" })).toEqual([]);
  });
});

describe("TC-PT-03 values from real files", () => {
  it("reads reordered and extra columns, currency text, Hindi / Marathi names, Loose Item Y/N, and marks bad numbers", async () => {
    const parsed = await parseImportFile(
      csv([
        "Stock Qty,Notes,MRP,Product Name,Category,Loose Item (Y/N),Selling Price,GST %",
        '5,keep cold,"₹1,299.00",  बासमती तांदूळ  ,Rice,N,Rs. 1250/-,5',
        "2.5,,,साखर,Sugar,Y,46,5",
        "3,,abc,Tea,Tea,N,-4,7",
      ]),
      "products.csv",
      { maxRows: 10 },
    );
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].fields).toMatchObject({ name: "बासमती तांदूळ", mrpPaise: 129_900, pricePaise: 125_000, quantity: 5, goodsKind: "PACKAGED", gstRateBp: 500 });
    expect(parsed.rows[1].fields).toMatchObject({ name: "साखर", goodsKind: "LOOSE", quantity: 2.5 });
    expect(rowErrors(parsed.rows[1].fields)).toEqual([]);
    const tea = parsed.rows[2].fields;
    expect(tea.invalidValues).toMatchObject({ mrp: "abc", price: "-4" });
    expect(rowErrors(tea)).toEqual(expect.arrayContaining([expect.stringMatching(/^MRP "abc"/), expect.stringMatching(/^Selling Price "-4"/), expect.stringMatching(/GST 7%/)]));
  });

  it("reads a formula cell's saved value and a header-only file as no rows", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow(["Product Name", "Category", "MRP", "Stock Qty", "Selling Price"]);
    ws.addRow(["Milk", "Milk", { formula: "30+4", result: 34 }, 5, 33]);
    const parsed = await parseImportFile(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), "f.xlsx", { maxRows: 10 });
    expect(parsed.rows[0].fields).toMatchObject({ mrpPaise: 3_400 });

    const headerOnly = await parseImportFile(csv(["Product Name,Category,MRP,Stock Qty"]), "h.csv", { maxRows: 10 });
    expect(headerOnly.rows).toHaveLength(0);
  });
});

describe("TC-PT-04 matching Hindi / Marathi names", () => {
  it("keeps letters of every script in the match key", () => {
    expect(matchKey("साखर")).toBe("साखर");
    expect(matchKey("  बासमती  तांदूळ! ")).toBe("बासमती तांदूळ");
    expect(matchKey("Amul-Gold 500ml")).toBe("amul gold 500ml");
  });

  it("does not match one Devanagari product to another of the same brand", () => {
    const m = (CatalogueMatcher as unknown as { prototype: CatalogueMatcher }).prototype;
    const matcher = Object.create(m) as CatalogueMatcher;
    Object.assign(matcher, { bySku: new Map(), byCode: new Map(), byProduct: new Map(), byGtin: new Map(), byBarcode: new Map(), byName: new Map() });
    matcher.addProduct({ id: "p1", code: "P00001", name: "साखर", categoryId: "c", brand: null, variant: "1 kg", approvalStatus: "APPROVED" }, {});
    expect(matcher.resolve({ name: "गहू" }).matchType).toBe("NEW");
    expect(matcher.resolve({ name: "साखर" }).product?.id).toBe("p1");
    // Name + Pack Size (no Size column) picks the right pack.
    matcher.addProduct({ id: "p2", code: "P00002", name: "साखर", categoryId: "c", brand: null, variant: "5 kg", approvalStatus: "APPROVED" }, {});
    expect(matcher.resolve({ name: "साखर", packSize: "5 kg" }).product?.id).toBe("p2");
  });
});

describe("TC-PT-05 the report's Error column", () => {
  it("puts the rejecting reasons in Error and marks the row not imported", async () => {
    const bytes = await reportXlsx({
      columns: [{ label: "Product Name", id: "Product Name" }],
      rows: [
        { rowNumber: 14, raw: { "Product Name": "Milk" }, status: "failed", messages: ["Error: Row 14: MRP missing", "No SKU: one will be generated (GK-…)."] },
        { rowNumber: 15, raw: { "Product Name": "Tea" }, status: "ready", messages: [] },
      ],
    });
    const ws = (await load(bytes)).getWorksheet("Result")!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual(["Row", "Product Name", "Error", "status", "messages"]);
    expect((ws.getRow(2).values as unknown[]).slice(1)).toEqual(["14", "Milk", "Row 14: MRP missing", "error – not imported", "No SKU: one will be generated (GK-…)."]);
    // The report reads back as an upload: its own columns are ignored.
    const again = await parseImportFile(bytes, "fix.xlsx", { maxRows: 10 });
    expect(again.rows[0].fields.name).toBe("Milk");
  });
});
