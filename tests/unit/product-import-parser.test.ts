/**
 * Bulk product upload — the parser and value normalisation
 * (docs/product-import-2026-10 §1–§2, §6). No database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { plannedStock } from "@/lib/product-import";
import { canonicalKey } from "@/server/product-import/columns";
import { checkImageUrl, fetchImage, ImageFetchError } from "@/server/product-import/image-fetch";
import * as N from "@/server/product-import/normalise";
import { parseImportFile } from "@/server/product-import/parse";
import { buildSimpleTemplate, reportCsv, SIMPLE_TEMPLATE_COLUMNS } from "@/server/product-import/workbooks";
import { amazonRow, buildAmazonWorkbook, PUZZLES_COLUMNS } from "../helpers/amazon-template";

const FIXTURE = path.join(__dirname, "..", "fixtures", "bulk_upload", "PUZZLES.xlsm");
const ok = <T>(r: N.Parsed<T>) => (r && r.ok ? r.value : undefined);

describe("PUZZLES.xlsm (Amazon Seller Central, product type PUZZLES)", () => {
  it("detects the 309-column Template sheet, maps by attribute key and reads data from row 8", async () => {
    const parsed = await parseImportFile(readFileSync(FIXTURE), "PUZZLES.xlsm", { maxRows: 5000 });
    expect(parsed.format).toBe("AMAZON_TEMPLATE");
    expect(parsed.sheetName).toBe("Template");
    // Reading stops at the Template sheet: sheets after it are never opened.
    expect(parsed.sheetNames).toEqual(["Instructions", "Data Definitions", "Template"]);
    expect(parsed.columns).toHaveLength(309);
    expect(parsed.columns[0]).toMatchObject({ label: "SKU", key: "contribution_sku#1.value", canonical: "contribution_sku.value", group: "Listing Identity" });
    expect(parsed.skippedTemplateRows).toEqual([6, 7]); // ABC123 example and the notice
    expect(parsed.hasMacros).toBe(true);
    const first = parsed.rows[0];
    expect(first.rowNumber).toBe(8);
    expect(first.fields).toMatchObject({
      sku: "PZ-1000-WORLDMAP",
      productType: "PUZZLES",
      brand: "Generic",
      hsnCode: "95032000",
      quantity: 25,
      mrpPaise: 99900,
      pricePaise: 64900,
      barcodeType: "EAN",
      categoryHints: ["Jigsaw Puzzles"],
    });
    expect(parsed.rows).toHaveLength(5);
  });

  it("turns repeated columns (#1–#5, Other Image URL ×8) into arrays and keeps every cell losslessly", async () => {
    const parsed = await parseImportFile(readFileSync(FIXTURE), "PUZZLES.xlsm", { maxRows: 5000 });
    const f = parsed.rows[0].fields;
    expect(f.bullets).toHaveLength(5);
    expect(f.otherImages).toEqual(["https://images.example-cdn.com/puzzles/wm-1000-2.jpg", "https://images.example-cdn.com/puzzles/wm-1000-3.jpg"]);
    expect(f.materials).toEqual(["Cardboard", "Paper"]);
    expect(f.themes).toEqual(["Maps", "Geography"]);
    expect(f.safetyWarnings).toHaveLength(1);
    expect(f.b2b).toEqual({ "purchasable_offer[audience=b2b].our_price.schedule.value_with_tax": 600 });
    // Lossless: every non-empty cell is in raw, keyed by the column's attribute key.
    const raw = parsed.rows[0].raw;
    expect(raw["contribution_sku#1.value"]).toBe("PZ-1000-WORLDMAP");
    expect(Object.keys(raw).length).toBeGreaterThan(50);
    // …and grouped by the template's section headers.
    expect(parsed.rows[0].attributes["Product Details"]["Bullet Point"]).toHaveLength(5);
    // Dimensions are normalised to cm and g.
    expect(f).toMatchObject({ itemWeightG: 650, itemLengthCm: 70, packageWeightG: 750, packageHeightCm: 6 });
  });

  it("reads Indian numbers, dd/mm/yyyy and Excel-serial dates, and Y/N flags from the template", async () => {
    const parsed = await parseImportFile(readFileSync(FIXTURE), "PUZZLES.xlsm", { maxRows: 5000 });
    const [, taj, floor, mini] = parsed.rows;
    expect(taj.fields).toMatchObject({ quantity: 1200, pricePaise: 129900, mrpPaise: 159900, saleStart: "2026-11-01", saleEnd: "2026-11-30", action: "UPSERT" });
    expect(floor.fields).toMatchObject({ barcodeType: "GTIN_EXEMPT", restockDate: "2026-10-05", alwaysAvailable: false, quantity: 0 });
    expect(mini.fields.quantity).toBeUndefined();
    expect(mini.fields.quantityInvalid).toBe("ten");
    expect(mini.warnings[0]).toMatch(/Quantity \(IN\): "ten" is not a whole number/);
  });

  it("works for any Amazon product type: generic key mapping, no PUZZLES-specific logic", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Template");
    ws.addRow(["settings=productTypes=GROCERY"]);
    ws.addRow(["Offer", null, null, null]);
    ws.addRow(["Seller SKU", "Title", "Qty", "Weird label"]);
    ws.addRow([
      "contribution_sku#1.value",
      "item_name[marketplace_id=A21TJRUUN4KGV][language_tag=en_IN]#1.value",
      "fulfillment_availability#1.quantity",
      "brand[marketplace_id=A21TJRUUN4KGV][language_tag=en_IN]#1.value",
    ]);
    ws.addRow(["G-1", "Tata Salt 1 kg", 30, "Tata"]);
    const parsed = await parseImportFile(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer), "grocery.xlsx", { maxRows: 10 });
    expect(parsed.format).toBe("AMAZON_TEMPLATE");
    expect(parsed.rows[0].fields).toMatchObject({ sku: "G-1", name: "Tata Salt 1 kg", quantity: 30, brand: "Tata" });
  });

  it("maps a row with only a name, only a barcode, only SKU + quantity, and skips a fully empty row", async () => {
    const bytes = await buildAmazonWorkbook(
      [
        amazonRow({ "Item Name": "Only Name" }),
        amazonRow({ "Product Id": "8901234567890" }),
        amazonRow({}),
        amazonRow({ SKU: "S-1", "Quantity (IN)": 4 }),
      ],
      { macros: false },
    );
    const parsed = await parseImportFile(bytes, "t.xlsx", { maxRows: 100 });
    expect(parsed.rows.map((r) => r.rowNumber)).toEqual([8, 9, 11]);
    expect(parsed.emptyRows).toBe(1);
    expect(parsed.rows[1].fields.gtin14).toBe("08901234567890");
    expect(parsed.rows[2].fields).toMatchObject({ sku: "S-1", quantity: 4 });
    expect(PUZZLES_COLUMNS).toHaveLength(309);
  });
});

describe("canonical attribute keys", () => {
  it("strips marketplace and language qualifiers, keeps the audience, records the occurrence", () => {
    expect(canonicalKey("bullet_point[marketplace_id=A21TJRUUN4KGV][language_tag=en_IN]#3.value")).toEqual({ canonical: "bullet_point.value", occurrence: 3 });
    expect(canonicalKey("purchasable_offer[marketplace_id=X][audience=ALL]#1.our_price#1.schedule#1.value_with_tax").canonical).toBe(
      "purchasable_offer[audience=all].our_price.schedule.value_with_tax",
    );
    expect(canonicalKey("purchasable_offer[marketplace_id=X][audience=B2B]#1.our_price#1.schedule#1.value_with_tax").canonical).toContain("[audience=b2b]");
    expect(canonicalKey("::record_action")).toEqual({ canonical: "::record_action", occurrence: null });
  });
});

describe("value normalisation", () => {
  it("numbers and money, the Indian way", () => {
    expect(ok(N.number("1,29,999.50"))).toBe(129999.5);
    expect(ok(N.paise("₹1,299.00"))).toBe(129900);
    expect(ok(N.paise("Rs. 99/-"))).toBe(9900);
    expect(ok(N.paise("INR 1299"))).toBe(129900);
    expect(ok(N.paise(649))).toBe(64900);
    expect(N.paise("99-120")).toEqual({ ok: false, raw: "99-120" });
    expect(N.paise("-5")).toEqual({ ok: false, raw: "-5" });
    expect(N.paise("")).toBeNull();
    expect(ok(N.wholeNumber("1,200"))).toBe(1200);
    expect(N.wholeNumber("2.5")).toMatchObject({ ok: false });
    expect(N.wholeNumber(-3)).toMatchObject({ ok: false });
  });

  it("dates: Excel serial, dd/mm/yyyy, ISO and month names", () => {
    expect(ok(N.date(46300))).toBe("2026-10-05");
    expect(ok(N.date(45658))).toBe("2025-01-01");
    expect(ok(N.date("15/10/2026"))).toBe("2026-10-15");
    expect(ok(N.date("15-10-26"))).toBe("2026-10-15");
    expect(ok(N.date("2026-10-15T00:00:00Z"))).toBe("2026-10-15");
    expect(ok(N.date("15 Oct 2026"))).toBe("2026-10-15");
    expect(N.date("31/02/2026")).toMatchObject({ ok: false });
    expect(N.date("soon")).toMatchObject({ ok: false });
  });

  it("units: lengths to cm, weights to g", () => {
    expect(ok(N.lengthCm(10, "Millimetres"))).toBe(1);
    expect(ok(N.lengthCm(2, "Centimeters"))).toBe(2);
    expect(ok(N.lengthCm("12 cm", null))).toBe(12);
    expect(ok(N.lengthCm(1, "inches"))).toBe(2.54);
    expect(ok(N.weightG(1.5, "Kilograms"))).toBe(1500);
    expect(ok(N.weightG(250, "Grams"))).toBe(250);
    expect(N.weightG(3, "stone")).toMatchObject({ ok: false });
    expect(N.unitCode("Centimetres")).toBe("cm");
    expect(N.unitCode("Kilograms")).toBe("kg");
  });

  it("booleans: Yes/No/True/False/Y/N", () => {
    for (const v of ["Yes", "y", "TRUE", "1"]) expect(ok(N.bool(v))).toBe(true);
    for (const v of ["No", "n", "false", "0"]) expect(ok(N.bool(v))).toBe(false);
    expect(N.bool("maybe")).toMatchObject({ ok: false });
  });

  it("barcodes, HSN and GST", () => {
    expect(N.barcode("8901234567890")).toMatchObject({ gtin14: "08901234567890", checkDigitValid: true });
    expect(N.gtinDigits("08901234567890")).toBe("8901234567890");
    expect(N.barcodeType("GTIN Exempt")).toBe("GTIN_EXEMPT");
    expect(ok(N.hsn("9503.20.00"))).toBe("95032000");
    expect(ok(N.gstRateBp("18%"))).toBe(1800);
  });
});

describe("CSV and the GoKesari simple template", () => {
  it("reads a semicolon CSV with a BOM", async () => {
    const csv = Buffer.from("﻿SKU;Product Name;Selling Price;Quantity\r\nC-1;Bread;₹45;12\r\n", "utf8");
    const parsed = await parseImportFile(csv, "products.csv", { maxRows: 10 });
    expect(parsed.format).toBe("CSV");
    expect(parsed.rows[0].fields).toMatchObject({ sku: "C-1", name: "Bread", pricePaise: 4500, quantity: 12 });
  });

  it("the template has every column, the Instructions sheet, three dropdowns, and its example row is never imported", async () => {
    const bytes = await buildSimpleTemplate();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const products = wb.getWorksheet("Products")!;
    expect((products.getRow(1).values as unknown[]).slice(1)).toEqual([...SIMPLE_TEMPLATE_COLUMNS]);
    expect(String(products.getRow(2).getCell(1).value)).toMatch(/^EXAMPLE – delete this row$/);
    const instructions = wb.getWorksheet("Instructions")!;
    expect(String(instructions.getRow(3).getCell(1).value)).toMatch(/ALL COLUMNS ARE OPTIONAL/);
    const validations = (products as unknown as { dataValidations: { model: Record<string, { formulae: string[] }> } }).dataValidations.model;
    const lists = Object.values(validations).map((v) => v.formulae[0]);
    expect(lists).toEqual(expect.arrayContaining([expect.stringContaining("GTIN Exempt"), expect.stringContaining("pcs,kg,g,l,ml,pack"), expect.stringContaining("Upsert,Edit,Delete")]));

    const parsed = await parseImportFile(bytes, "GoKesari_Product_Upload_Template.xlsx", { maxRows: 10 });
    expect(parsed.format).toBe("GOKESARI_TEMPLATE");
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.skippedTemplateRows).toEqual([2]);
  });

  it("the report defangs formula injection", () => {
    const csv = reportCsv({ columns: [{ label: "SKU", id: "SKU" }], rows: [{ rowNumber: 2, raw: { SKU: "=HYPERLINK(\"x\")" }, status: "created", messages: [] }] }).toString("utf8");
    expect(csv).toContain("'=HYPERLINK");
  });

  it("refuses files that are not spreadsheets", async () => {
    await expect(parseImportFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "old.xls", { maxRows: 5 })).rejects.toMatchObject({ status: 422 });
    await expect(parseImportFile(Buffer.from("%PDF-1.7"), "x.pdf", { maxRows: 5 })).rejects.toMatchObject({ status: 422 });
  });
});

describe("planned stock (preview)", () => {
  it("follows the mode", () => {
    const plan = { outcome: "update" as const, currentQty: 10, fileQty: 4, fileQtySum: 7 };
    expect(plannedStock(plan, "SET")).toBe(4);
    expect(plannedStock(plan, "ADD")).toBe(17);
    expect(plannedStock({ ...plan, fileQty: null, fileQtySum: null }, "SET")).toBeNull();
    expect(plannedStock({ outcome: "create", currentQty: null, fileQty: null, fileQtySum: null }, "SET")).toBe(0);
    expect(plannedStock({ ...plan, outcome: "deactivate" }, "ADD")).toBe(0);
  });
});

describe("image URLs (SSRF)", () => {
  it("allows only public http(s) addresses", () => {
    expect(checkImageUrl("https://cdn.example.com/a.jpg").hostname).toBe("cdn.example.com");
    for (const bad of [
      "http://127.0.0.1/x.jpg",
      "http://10.0.0.5/x.jpg",
      "http://169.254.169.254/latest/meta-data",
      "http://192.168.1.1/a.png",
      "http://[::1]/a.png",
      "http://localhost/a.png",
      "file:///etc/passwd",
      "ftp://example.com/a.jpg",
      "https://user:pass@example.com/a.jpg",
    ]) {
      expect(() => checkImageUrl(bad), bad).toThrow(ImageFetchError);
    }
  });

  it("refuses a host name that resolves to a private address (checked at connect time)", async () => {
    const lookup = ((_host: string, _opts: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "10.1.2.3", family: 4 }])) as never;
    await expect(fetchImage("http://images.attacker.example/a.jpg", { maxBytes: 1000, timeoutMs: 2000, lookup })).rejects.toMatchObject({ reason: "BLOCKED" });
  });
});
