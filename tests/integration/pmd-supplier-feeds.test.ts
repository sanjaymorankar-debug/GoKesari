/**
 * GS1 India and manufacturer catalogues, end to end against a real PostgreSQL.
 *
 * The connectors run the SHIPPED mapping templates (registry `gs1_india` and
 * `brand_manufacturer_feeds`) through the real pipeline. The sources are re-keyed `test_*` and set
 * ACTIVE for the test only - the real entries stay blocked / planned until an agreement exists,
 * which the last test proves.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ExcelJS from "exceljs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { analyzeGtin, gs1CheckDigit } from "@/server/pmd/normalize/identifiers";
import { runIngestion, SourceNotEnabledError } from "@/server/pmd/pipeline/run";
import { upsertSources } from "@/server/pmd/reference-data";
import { standardCodeMapper } from "@/server/pmd/services/ingest-api";
import { createTabularFeedAdapter } from "@/server/pmd/sources/adapters/csv-feed";
import { getSourceDefinition } from "@/server/pmd/sources/registry";
import { chainMappers, createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import type { SourceDefinition } from "@/server/pmd/types";
import { count, GTIN, ingest, pmdSql, product, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const gtin14 = (g: string) => analyzeGtin(g)!.gtin14;

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

/** The shipped registry entry, re-keyed and enabled for the test. */
const asTestSource = (registryKey: string, key: string): SourceDefinition => ({
  ...getSourceDefinition(registryKey)!,
  key,
  status: "ACTIVE",
  legalBasis: "Synthetic fixture used only by automated tests.",
});

const inTempDir = async <T,>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "pmd-supplier-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("GS1 India connector (shipped mapping template)", () => {
  const GS1_HEADER = ["GTIN", "Product Description", "Brand Name", "Brand Owner Name", "Net Content", "Net Content UoM", "GPC Brick Code", "GPC Brick Name", "Country of Origin", "GST Rate", "HSN Code", "MRP", "Brand Owner GLN"];
  const OWNER = "Gujarat Co-operative Milk Marketing Federation Ltd";

  it("outranks open data: fills brand owner, tax, category and MRP on a product open data already knew", async () => {
    // Open data knew the product by barcode, with a crowd-typed name and nothing else.
    await ingest("test_open", [product({ sourceProductId: "OFF-1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, quantityText: "500 g" })], { kind: "OPEN_DATA" });

    const def = asTestSource("gs1_india", "test_gs1");
    await upsertSources(sql, [def]);
    const csv = [
      GS1_HEADER.join(","),
      [GTIN.AMUL_BUTTER_500, "Amul Butter Pasteurised 500 g", "Amul", OWNER, "500", "GRM", "GPC-T1", "Butter", "India", "12%", "0405", "285", "8901058000000"].join(","),
      [GTIN.AMUL_BUTTER_100, "Amul Butter Pasteurised 100 g", "Amul", OWNER, "100", "GRM", "GPC-T1", "Butter", "India", "12%", "0405", "58", "8901058000000"].join(","),
    ].join("\n") + "\n";

    await inTempDir(async (dir) => {
      const path = join(dir, "gs1.csv");
      writeFileSync(path, csv);
      const adapter = createTabularFeedAdapter({
        definition: def,
        input: { path },
        mapping: def.fieldMapping!,
        categoryMapper: chainMappers(createCategoryMapper({ tags: { "GPC-T1": "dairy/butter-and-margarine" }, keywords: [] }), standardCodeMapper()),
      });
      expect(adapter.collectionMethod).toBe("LICENSED_FEED_CSV");
      const run = await runIngestion(sql, adapter, { mode: "IMPORT" });
      expect(run.counters).toMatchObject({ recordsRead: 2, productsLinked: 1, productsCreated: 1, errorCount: 0 });
    });

    expect(await count(sql, "pmd.product_master")).toBe(2); // the barcode-matched one was NOT duplicated
    const [m] = await sql<{ product_name: string; manufacturer_name: string | null; gst_rate_bp: number | null; hsn_code: string | null; category_code: string | null; pack_size: string | null; name_source: string }[]>`
      SELECT pm.product_name, mf.manufacturer_name, pm.gst_rate_bp, pm.hsn_code, c.category_code, pm.pack_size,
             (SELECT source_key FROM pmd.source WHERE source_id = (pm.field_sources ->> 'product_name')::int) AS name_source
      FROM pmd.product_master pm LEFT JOIN pmd.manufacturer mf USING (manufacturer_id) LEFT JOIN pmd.category c ON c.category_id = pm.category_id
      WHERE pm.gtin = ${gtin14(GTIN.AMUL_BUTTER_500)}`;
    expect(m).toEqual({
      product_name: "Amul Butter Pasteurised 500 g", // GS1 outranks the crowd-typed name
      manufacturer_name: OWNER,
      gst_rate_bp: 1200,
      hsn_code: "0405",
      category_code: "dairy/butter-and-margarine",
      pack_size: "500 g", // "{500} {GRM|unece}" -> "500 g"
      name_source: "test_gs1",
    });

    // GS1's own classification and owner id are kept as traceable specifications...
    const specs = await sql<{ attribute_key: string; value_text: string }[]>`
      SELECT s.attribute_key, s.value_text FROM pmd.product_specification s JOIN pmd.product_master pm USING (product_id)
      WHERE pm.gtin = ${gtin14(GTIN.AMUL_BUTTER_500)} AND s.attribute_key IN ('gpc_brick_code', 'gpc_brick_name', 'brand_owner_gln') ORDER BY 1`;
    expect(specs).toEqual([
      { attribute_key: "brand_owner_gln", value_text: "8901058000000" },
      { attribute_key: "gpc_brick_code", value_text: "GPC-T1" },
      { attribute_key: "gpc_brick_name", value_text: "Butter" },
    ]);
    // ...and the MRP arrives as the brand owner's offer, with no selling price invented.
    const [offer] = await sql<{ seller_name: string; mrp_minor: number; price_minor: number | null }[]>`
      SELECT o.seller_name, o.mrp_minor, o.price_minor FROM pmd.product_offer o JOIN pmd.source s USING (source_id)
      JOIN pmd.product_master pm ON pm.product_id = o.product_id WHERE s.source_key = 'test_gs1' AND pm.gtin = ${gtin14(GTIN.AMUL_BUTTER_500)}`;
    expect(offer).toEqual({ seller_name: OWNER, mrp_minor: 28500, price_minor: null });
  });

  it("the real gs1_india entry stays blocked and cannot run until an agreement exists", async () => {
    const real = getSourceDefinition("gs1_india")!;
    expect(real.status).toBe("BLOCKED_NEEDS_AGREEMENT");
    const adapter = createTabularFeedAdapter({ definition: real, input: { rows: [{ GTIN: GTIN.TEA, "Product Description": "x" }] }, mapping: real.fieldMapping! });
    await expect(runIngestion(sql, adapter, { mode: "IMPORT" })).rejects.toBeInstanceOf(SourceNotEnabledError);
    expect(await count(sql, "pmd.product_master")).toBe(0);
  });
});

describe("manufacturer catalogue connector (Excel workbook, shipped mapping template)", () => {
  it("loads an .xlsx catalogue: numeric barcodes, restored UPC zeros, MRP and GST, padding rows, and a bad row logged", async () => {
    const def = asTestSource("brand_manufacturer_feeds", "test_mfr_acme");
    await upsertSources(sql, [def]);
    const upc = "01234567890" + gs1CheckDigit("01234567890"); // Excel will store this as a number and drop the leading zero

    await inTempDir(async (dir) => {
      const path = join(dir, "acme-catalogue.xlsx");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Catalogue");
      ws.addRow(["Acme Foods Ltd - Product Catalogue Sept 2026"]);
      ws.addRow(["Item Code", "Barcode (EAN)", "Product Name", "Brand", "Marketed By", "Pack Size", "Category", "GST %", "HSN", "Country of Origin", "MRP", "Ingredients", "Shelf Life"]);
      ws.addRow(["AF-1", Number(GTIN.MILK_1L), "Acme Toned Milk 1 L", "Acme", "Acme Foods Ltd", "1 L", "Milk", "0%", "0401", "India", 62, "Toned milk", "3 months"]);
      ws.addRow(["AF-2", Number(upc), "Acme Poha 500 g", "Acme", "Acme Foods Ltd", "500 g", "Poha", "5%", "1904", "India", 45, "Flattened rice", "6 months"]);
      ws.addRow([]);
      ws.addRow(["AF-3", 0, "", "Acme", "Acme Foods Ltd", "", "", "", "", "", 10, "", ""]); // no product name
      await wb.xlsx.writeFile(path);

      const adapter = createTabularFeedAdapter({
        definition: def,
        input: { path },
        headerRow: 2,
        mapping: def.fieldMapping!,
        categoryMapper: chainMappers(createCategoryMapper({ tags: { Milk: "dairy/milk/toned-milk" }, keywords: [] }), standardCodeMapper()),
      });
      expect(adapter.collectionMethod).toBe("MANUFACTURER_FEED_XLSX");
      const run = await runIngestion(sql, adapter, { mode: "IMPORT" });
      expect(run.counters).toMatchObject({ recordsRead: 3, productsCreated: 2, errorCount: 1 }); // the blank padding row is not a record
    });

    const rows = await sql<{ product_name: string; gtin: string | null; gst_rate_bp: number | null; hsn_code: string | null; category_code: string | null; mrp_minor: number; method: string }[]>`
      SELECT pm.product_name, pm.gtin, pm.gst_rate_bp, pm.hsn_code, c.category_code, o.mrp_minor::int AS mrp_minor, ps.data_collection_method AS method
      FROM pmd.product_master pm JOIN pmd.product_source ps ON ps.product_id = pm.product_id JOIN pmd.product_offer o ON o.product_source_id = ps.product_source_id
      LEFT JOIN pmd.category c ON c.category_id = pm.category_id ORDER BY pm.product_id`;
    expect(rows).toEqual([
      { product_name: "Acme Toned Milk 1 L", gtin: gtin14(GTIN.MILK_1L), gst_rate_bp: 0, hsn_code: "0401", category_code: "dairy/milk/toned-milk", mrp_minor: 6200, method: "MANUFACTURER_FEED_XLSX" },
      // the UPC-A whose leading zero Excel stripped is identified by its real barcode, not stored as an opaque code
      { product_name: "Acme Poha 500 g", gtin: gtin14(upc), gst_rate_bp: 500, hsn_code: "1904", category_code: null, mrp_minor: 4500, method: "MANUFACTURER_FEED_XLSX" },
    ]);
    const errs = await sql<{ source_record_id: string; error_code: string }[]>`SELECT source_record_id, error_code FROM pmd.import_error WHERE severity = 'ERROR'`;
    expect(errs).toEqual([{ source_record_id: "AF-3", error_code: "NAME_MISSING" }]);
  });

  it("manufacturer data outranks a marketplace for tax and name, and the source is trusted for MRP", async () => {
    await ingest("test_market", [product({ sourceProductId: "M-1", name: "acme toned milk 1l", brand: "Acme", gtin: GTIN.MILK_1L, quantityText: "1 L", gstRate: "5%" })], { kind: "MARKETPLACE" });
    const def = asTestSource("brand_manufacturer_feeds", "test_mfr_acme");
    await upsertSources(sql, [def]);
    const adapter = createTabularFeedAdapter({
      definition: def,
      input: { rows: [{ "Item Code": "AF-1", "Barcode (EAN)": GTIN.MILK_1L, "Product Name": "Acme Toned Milk 1 L", Brand: "Acme", "Pack Size": "1 L", "GST %": "0%", HSN: "0401", MRP: "62" }] },
      mapping: def.fieldMapping!,
    });
    const run = await runIngestion(sql, adapter, { mode: "IMPORT" });
    expect(run.counters).toMatchObject({ productsLinked: 1, productsCreated: 0 });
    const [m] = await sql<{ product_name: string; gst_rate_bp: number }[]>`SELECT product_name, gst_rate_bp FROM pmd.product_master`;
    expect(m).toEqual({ product_name: "Acme Toned Milk 1 L", gst_rate_bp: 0 }); // the manufacturer's 0% beats the marketplace's 5%
    const kind = await sql<{ source_kind: string }[]>`SELECT source_kind FROM pmd.source WHERE source_key = 'test_mfr_acme'`;
    expect(kind[0].source_kind).toBe("BRAND_MANUFACTURER"); // the class the catalogue bridge trusts for an MRP (pending verification)
  });

  it("the real manufacturer template is planned, not runnable", () => {
    const real = getSourceDefinition("brand_manufacturer_feeds")!;
    expect(real.status).toBe("PLANNED");
    expect(real.parserKey).toBe("tabular_feed");
  });
});
