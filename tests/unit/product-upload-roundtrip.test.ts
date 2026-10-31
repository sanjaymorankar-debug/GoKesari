/**
 * Bulk product upload, Phase 1 additions (docs/audit/order-payment-gst-audit.md,
 * Area 5): CSV template, GST % and Goods Type dropdowns, preview checks,
 * loose goods, and the "download my catalogue" file read back by the upload
 * parser. No database.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseImportFile } from "@/server/product-import/parse";
import {
  buildCatalogueWorkbook,
  buildSimpleTemplate,
  buildSimpleTemplateCsv,
  SIMPLE_TEMPLATE_COLUMNS,
} from "@/server/product-import/workbooks";
import { previewChecks } from "@/server/product-import/preview-checks";

describe("templates", () => {
  it("TC-PU-001 the CSV template has the Excel template's header and the example row", async () => {
    const csv = buildSimpleTemplateCsv().toString("utf8").replace(/^﻿/, "");
    const [header] = csv.split("\r\n");
    expect(header.split(",")).toEqual([...SIMPLE_TEMPLATE_COLUMNS]);
    expect(csv).toContain("EXAMPLE – delete this row");
    // The parser reads it and skips the example row.
    const parsed = await parseImportFile(buildSimpleTemplateCsv(), "template.csv", { maxRows: 5000 });
    expect(parsed.rows).toHaveLength(0);
  });

  it("TC-PU-002 the Excel template offers GST % and Goods Type as dropdowns", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildSimpleTemplate()) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Products")!;
    const cell = (column: string) => ws.getCell(2, SIMPLE_TEMPLATE_COLUMNS.indexOf(column as (typeof SIMPLE_TEMPLATE_COLUMNS)[number]) + 1);
    expect(cell("GST %").dataValidation).toMatchObject({ type: "list" });
    expect(String(cell("GST %").dataValidation.formulae?.[0])).toContain("18");
    expect(String(cell("GST %").dataValidation.formulae?.[0])).toContain("40");
    expect(cell("Goods Type").dataValidation.formulae?.[0]).toBe('"Packaged,Loose"');
  });
});

describe("preview checks", () => {
  it("TC-PU-003 flags a selling price above the MRP, a zero price and a GST rate that is not a slab", () => {
    expect(previewChecks({ pricePaise: 3_500, mrpPaise: 3_400 })[0]).toMatch(/above the MRP ₹34\.00/);
    expect(previewChecks({ pricePaise: 0 })[0]).toMatch(/more than 0/);
    expect(previewChecks({ gstRateBp: 700 })[0]).toMatch(/GST 7% is not a GST rate/);
    expect(previewChecks({ pricePaise: 3_300, mrpPaise: 3_400, gstRateBp: 500 })).toEqual([]);
  });

  it("TC-PU-004 a loose good needs a weight or volume unit", () => {
    expect(previewChecks({ goodsKind: "LOOSE", unit: "pcs" })[0]).toMatch(/kg, g, l or ml/);
    expect(previewChecks({ goodsKind: "LOOSE", unit: "kg" })).toEqual([]);
  });
});

describe("download my catalogue → upload again", () => {
  const rows = [
    {
      SKU: "RICE-5KG",
      "Product Name": "India Gate Basmati Rice 5 kg",
      Brand: "India Gate",
      Category: "Rice",
      "HSN Code": "10063020",
      "GST %": 5,
      MRP: 899,
      "Selling Price": 849,
      Quantity: 12,
      Unit: "pack",
      "Goods Type": "Packaged",
      Action: "Upsert",
    },
    {
      SKU: "P00042",
      "Product Name": "Toor Dal (loose)",
      "HSN Code": "07136000",
      "GST %": 0,
      MRP: null,
      "Selling Price": 140,
      Quantity: 7.5,
      Unit: "kg",
      "Goods Type": "Loose",
      Action: "Upsert",
    },
  ];

  for (const format of ["xlsx", "csv"] as const) {
    it(`TC-PU-005 the ${format} export is read back with the same SKU, prices, stock, HSN, GST and goods type`, async () => {
      const bytes = await buildCatalogueWorkbook(rows, format);
      const parsed = await parseImportFile(bytes, `catalogue.${format}`, { maxRows: 5000 });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0].fields).toMatchObject({
        sku: "RICE-5KG",
        name: "India Gate Basmati Rice 5 kg",
        hsnCode: "10063020",
        gstRateBp: 500,
        mrpPaise: 89_900,
        pricePaise: 84_900,
        quantity: 12,
        goodsKind: "PACKAGED",
        action: "UPSERT",
      });
      expect(parsed.rows[1].fields).toMatchObject({ sku: "P00042", pricePaise: 14_000, quantity: 7.5, goodsKind: "LOOSE", gstRateBp: 0 });
      expect(parsed.rows[1].fields.mrpPaise).toBeUndefined();
    });
  }

  it("TC-PU-006 an MRP typed on a loose good is not used", async () => {
    const bytes = await buildCatalogueWorkbook([{ SKU: "SUGAR", "Product Name": "Sugar", MRP: 50, "Selling Price": 45, Unit: "kg", "Goods Type": "Loose" }], "csv");
    const parsed = await parseImportFile(bytes, "c.csv", { maxRows: 5000 });
    expect(parsed.rows[0].fields.mrpPaise).toBeUndefined();
    expect(parsed.rows[0].warnings.join(" ")).toMatch(/loose goods carry no MRP/);
  });
});
