/**
 * Product Master Data Platform - the pipeline against a real PostgreSQL.
 *
 * Each test maps to an acceptance criterion of the brief. Fixtures are SYNTHETIC
 * (clearly named test_* sources) - they exist to prove behaviour that real open data
 * cannot show (multi-marketplace conflicts, seller-level price history, incremental
 * change). The real-data pilot is a separate, reported run.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getTaxonomy } from "@/server/pmd/taxonomy/categories";
import { ATTRIBUTE_DEFINITIONS } from "@/server/pmd/taxonomy/attributes";
import { createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { ensureReferenceData } from "@/server/pmd/reference-data";
import { runIngestion, SourceNotEnabledError } from "@/server/pmd/pipeline/run";
import { createRowsAdapter } from "@/server/pmd/sources/adapters/rows";
import { getSourceDefinition, SOURCE_REGISTRY } from "@/server/pmd/sources/registry";
import { ParseError } from "@/server/pmd/sources/adapter";
import { count, GTIN, ingest, pmdSql, product, registerTestSource, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetPmd();
});

const masters = () => sql<{ product_id: number; master_product_id: string; product_name: string; gtin: string | null; product_family_id: number | null; product_status: string; version: number; color: string | null; material: string | null; description: string | null }[]>`
  SELECT product_id, master_product_id, product_name, gtin, product_family_id, product_status, version, color, material, long_description AS description
  FROM pmd.product_master ORDER BY product_id`;

describe("reference data", () => {
  it("seeds the taxonomy, attribute registry and every source in the brief - idempotently", async () => {
    await seedReference();
    await seedReference();
    expect(await count(sql, "pmd.category")).toBe(getTaxonomy().length);
    expect(await count(sql, "pmd.attribute_definition")).toBeGreaterThanOrEqual(ATTRIBUTE_DEFINITIONS.length);
    for (const key of ["amazon_in", "flipkart", "myntra", "meesho", "reliance_digital", "croma", "tata_cliq", "vijay_sales", "bigbasket",
      "blinkit", "zepto", "swiggy_instamart", "jiomart", "dmart_ready", "nykaa", "firstcry", "pepperfry", "ajio", "snapdeal",
      "indiamart", "moglix", "gs1_india", "fssai_foscos", "gst_portal", "open_food_facts"]) {
      expect(await count(sql, "pmd.source", `source_key = '${key}'`), key).toBe(1);
    }
    expect(SOURCE_REGISTRY.every((s) => s.legalBasis.length > 20)).toBe(true);
  });

  it("registers marketplaces as blocked and disabled - they cannot collect without an agreed route", async () => {
    const rows = await sql<{ source_key: string; status: string; enabled: boolean }[]>`
      SELECT source_key, status, enabled FROM pmd.source WHERE source_kind = 'MARKETPLACE' AND source_key NOT LIKE 'test_%'`;
    expect(rows.length).toBeGreaterThanOrEqual(21);
    for (const r of rows) expect(r, r.source_key).toMatchObject({ status: "BLOCKED_NEEDS_AGREEMENT", enabled: false });
  });

  it("the database refuses to enable a source that is not ACTIVE", async () => {
    await expect(sql`UPDATE pmd.source SET enabled = true WHERE source_key = 'amazon_in'`).rejects.toThrow(/source_enabled_requires_active/);
  });

  it("re-syncing never consumes identity values - source_id is a smallint and every run used to burn 41 of it", async () => {
    await ensureReferenceData(sql, { force: true });
    const seq = async () => {
      const [r] = await sql<{ s: number; c: number }[]>`
        SELECT (SELECT last_value FROM pmd.source_source_id_seq)::int AS s, (SELECT last_value FROM pmd.category_category_id_seq)::int AS c`;
      return r;
    };
    const before = await seq();
    await ensureReferenceData(sql, { force: true });
    await ensureReferenceData(sql, { force: true });
    expect(await seq()).toEqual(before);
    // ...and ordinary runs do not touch the sequences either
    await ingest("test_market_a", [product({ sourceProductId: "S1", name: "Sequence Probe", brand: "Acme" })]);
    await ingest("test_market_a", [product({ sourceProductId: "S2", name: "Sequence Probe Two", brand: "Acme" })]);
    const after = await seq();
    expect(after.c).toBe(before.c);
    expect(after.s - before.s).toBeLessThanOrEqual(1); // only the one new test source
  });

  it("is cheap when nothing changed: it syncs only when the definitions differ from what the database last received", async () => {
    await ensureReferenceData(sql, { force: true });
    expect((await ensureReferenceData(sql)).synced).toBe(false);

    // a hand edit survives while the definitions are unchanged...
    await sql`UPDATE pmd.source SET notes = 'edited by hand' WHERE source_key = 'partner_feed'`;
    expect((await ensureReferenceData(sql)).synced).toBe(false);
    expect((await sql<{ notes: string }[]>`SELECT notes FROM pmd.source WHERE source_key = 'partner_feed'`)[0].notes).toBe("edited by hand");

    // ...and is put right once the stored fingerprint no longer matches the code, or on --force
    await sql`UPDATE pmd.reference_state SET content_hash = 'stale'`;
    expect((await ensureReferenceData(sql)).synced).toBe(true);
    expect((await sql<{ notes: string }[]>`SELECT notes FROM pmd.source WHERE source_key = 'partner_feed'`)[0].notes).not.toBe("edited by hand");
    expect((await ensureReferenceData(sql)).synced).toBe(false);
  });

  it("a steward's 'disabled' source stays disabled across a re-sync", async () => {
    await sql`UPDATE pmd.source SET enabled = false WHERE source_key = 'open_prices'`;
    await ensureReferenceData(sql, { force: true });
    expect((await sql<{ enabled: boolean }[]>`SELECT enabled FROM pmd.source WHERE source_key = 'open_prices'`)[0].enabled).toBe(false);
    await sql`UPDATE pmd.source SET enabled = true WHERE source_key = 'open_prices'`; // restore for the other tests
    await ensureReferenceData(sql, { force: true });
    expect((await sql<{ enabled: boolean }[]>`SELECT enabled FROM pmd.source WHERE source_key = 'open_prices'`)[0].enabled).toBe(true);
  });

  it("refuses to run a blocked source, whatever adapter is supplied", async () => {
    const adapter = createRowsAdapter({ definition: getSourceDefinition("amazon_in")!, rows: [product({ sourceProductId: "B0X", name: "Anything" })] });
    await expect(runIngestion(sql, adapter, { mode: "PILOT" })).rejects.toBeInstanceOf(SourceNotEnabledError);
    expect(await count(sql, "pmd.ingestion_run")).toBe(0);
    expect(await count(sql, "pmd.product_master")).toBe(0);
  });
});

describe("collection -> normalisation -> master creation", () => {
  it("creates one master per product with a unique GKS-PROD id, canonical GTIN, brand and source trace", async () => {
    const res = await ingest("test_market_a", [
      product({ sourceProductId: "A1", name: "Amul Butter 100 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_100, gstRate: "12%", hsnCode: "0405.10.00", countryOfOrigin: "Made in India" }),
      product({ sourceProductId: "A2", name: "Amul Butter 500 g", brand: "AMUL India", gtin: GTIN.AMUL_BUTTER_500 }),
    ]);
    expect(res).toMatchObject({ status: "SUCCEEDED" });
    expect(res.counters).toMatchObject({ recordsRead: 2, productsCreated: 2, errorCount: 0 });

    const rows = await masters();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.master_product_id).toMatch(/^GKS-PROD-\d{9}$/);
    expect(new Set(rows.map((r) => r.master_product_id)).size).toBe(2);
    expect(rows[0].gtin).toBe("0" + GTIN.AMUL_BUTTER_100);

    // Amul / AMUL India -> ONE brand, both spellings preserved.
    expect(await count(sql, "pmd.brand")).toBe(1);
    const aliases = await sql<{ alias_original: string }[]>`SELECT alias_original FROM pmd.brand_alias ORDER BY alias_original`;
    expect(aliases.map((a) => a.alias_original)).toEqual(["AMUL India", "Amul"]);

    const [m] = await sql<{ gst_rate_bp: number; hsn_code: string; net_quantity_value: number; net_quantity_unit: string; pack_size: string; ean: string }[]>`
      SELECT gst_rate_bp, hsn_code, net_quantity_value, net_quantity_unit, pack_size, ean FROM pmd.product_master WHERE product_id = ${rows[0].product_id}`;
    expect(m).toMatchObject({ gst_rate_bp: 1200, hsn_code: "04051000", net_quantity_value: 100, net_quantity_unit: "g", pack_size: "100 g", ean: GTIN.AMUL_BUTTER_100 });

    // Source traceability: where it came from, how, when.
    const [s] = await sql<{ source_product_id: string; data_collection_method: string; resolution: string; match_status: string; first_seen_date: string }[]>`
      SELECT source_product_id, data_collection_method, resolution, match_status, first_seen_date FROM pmd.product_source ORDER BY product_source_id LIMIT 1`;
    expect(s).toMatchObject({ source_product_id: "A1", data_collection_method: "MANUAL_UPLOAD_JSON", resolution: "CREATED_NEW", match_status: "NO_CANDIDATE" });
    expect(s.first_seen_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The raw payload is kept.
    expect(await count(sql, "pmd.raw_record")).toBe(2);
    // Country and tax facts each carry their source.
    const spec = await sql<{ attribute_key: string; source_id: number }[]>`SELECT attribute_key, source_id FROM pmd.product_specification WHERE product_id = ${rows[0].product_id}`;
    expect(spec.map((x) => x.attribute_key)).toEqual(expect.arrayContaining(["country_of_origin", "gst_rate_bp", "hsn_code"]));
  });

  it("never stores price or MRP on the product itself", async () => {
    const cols = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'pmd' AND table_name = 'product_master'`;
    const names = cols.map((c) => c.column_name);
    expect(names.filter((n) => /price|mrp|discount/.test(n))).toEqual([]);
  });

  it("stores missing data as NULL - never zero", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "M1", name: "Mystery Item" })]);
    const [m] = await sql<Record<string, unknown>[]>`SELECT * FROM pmd.product_master`;
    for (const col of ["gtin", "brand_id", "manufacturer_id", "category_id", "gst_rate_bp", "hsn_code", "net_weight_g", "net_quantity_value", "pack_count", "long_description"]) {
      expect(m[col], col).toBeNull();
    }
  });

  it("scores data quality between 0 and 100 and lists what is missing", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "Q1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })]);
    const [m] = await sql<{ data_quality_score: number; quality_components: { missingFields: string[]; components: Record<string, { score: number | null }> } }[]>`
      SELECT data_quality_score, quality_components FROM pmd.product_master`;
    expect(m.data_quality_score).toBeGreaterThan(0);
    expect(m.data_quality_score).toBeLessThanOrEqual(100);
    expect(m.quality_components.missingFields).toEqual(expect.arrayContaining(["manufacturer", "gst_rate", "hsn_code"]));
    expect(m.quality_components.components.identifier.score).toBe(100);
  });

  it("maps source categories onto the standard taxonomy", async () => {
    const mapper = createCategoryMapper({ tags: { "en:milks": "dairy/milk" }, keywords: [] });
    await ingest("test_market_a", [product({ sourceProductId: "C1", name: "Toned Milk", categories: ["en:dairies", "en:milks"] })], { adapterOverride: { categoryMapper: mapper } });
    const [c] = await sql<{ category_code: string; path_names: string[] }[]>`
      SELECT c.category_code, c.path_names FROM pmd.product_master pm JOIN pmd.category c USING (category_id)`;
    expect(c).toMatchObject({ category_code: "dairy/milk", path_names: ["Dairy", "Milk"] });
  });
});

describe("deduplication across sources and sellers", () => {
  it("the same product (same GTIN) from two sources is ONE master with two source records", async () => {
    await ingest("test_brand_feed", [product({ sourceProductId: "BR-1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })], { kind: "BRAND_MANUFACTURER" });
    const res = await ingest("test_market_a", [product({ sourceProductId: "ASIN-1", name: "AMUL Pasteurised Butter, 500g pack", brand: "Amul India", gtin: GTIN.AMUL_BUTTER_500 })]);
    expect(res.counters).toMatchObject({ productsLinked: 1, productsCreated: 0 });
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.product_source")).toBe(2);
    const [cand] = await sql<{ review_status: string; match_status: string; reasons: { rule: string } }[]>`SELECT review_status, match_status, reasons FROM pmd.match_candidate`;
    expect(cand).toMatchObject({ review_status: "AUTO_LINKED", match_status: "EXACT_MATCH" });
    expect(cand.reasons.rule).toBe("L1_GTIN_BRAND");
  });

  it("one product sold by five sellers is one master and five offers", async () => {
    const sellers = ["Alpha Traders", "Beta Stores", "Gamma Retail", "Delta Mart", "Epsilon Shop"];
    await ingest("test_market_a", sellers.map((s, i) =>
      product({ sourceProductId: "TV-55", name: "Samsung 55 inch 4K Smart TV", brand: "Samsung", model: "UA55AUE60", offer: { sellerName: s, price: 40000 + i * 500, mrp: 55000, stock: "in stock" } })));
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.product_offer")).toBe(5);
    expect(await count(sql, "pmd.price_history")).toBe(5);
    const [m] = await masters();
    expect(m.product_status).toBe("ACTIVE");
  });

  it("different pack sizes stay separate products, grouped in one family", async () => {
    await ingest("test_market_a", [
      product({ sourceProductId: "T-500", name: "Tata Salt 500 g", brand: "Tata" }),
      product({ sourceProductId: "T-1K", name: "Tata Salt 1 kg", brand: "Tata" }),
      product({ sourceProductId: "T-2x500", name: "Tata Salt 2 x 500 g", brand: "Tata" }),
    ]);
    const rows = await masters();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.product_family_id)).size).toBe(1);
    expect(rows[0].product_family_id).not.toBeNull();
  });

  it("different variants (colour of one model) stay separate products", async () => {
    await ingest("test_brand_feed", [
      product({ sourceProductId: "S23-BK", name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Phantom Black", gtin: GTIN.PHONE_BLACK }),
      product({ sourceProductId: "S23-CR", name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Cream", gtin: GTIN.PHONE_BLUE }),
    ], { kind: "BRAND_MANUFACTURER" });
    expect(await count(sql, "pmd.product_master")).toBe(2);
  });

  it("variants without any GTIN are still kept apart (colour is a hard conflict)", async () => {
    await ingest("test_market_a", [
      product({ sourceProductId: "V1", name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Phantom Black" }),
      product({ sourceProductId: "V2", name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", color: "Cream" }),
    ]);
    expect(await count(sql, "pmd.product_master")).toBe(2);
  });

  it("a possible duplicate is queued for review and NEVER auto-merged", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul" })]);
    const res = await ingest("test_market_b", [product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul" })]);
    expect(await count(sql, "pmd.product_master")).toBe(2);
    expect(res.counters.reviewQueued).toBe(1);
    const [c] = await sql<{ match_status: string; review_status: string; match_score: number }[]>`SELECT match_status, review_status, match_score FROM pmd.match_candidate`;
    expect(c).toMatchObject({ match_status: "POSSIBLE_MATCH", review_status: "PENDING" });
    expect(c.match_score).toBeLessThan(92);
    const metrics = await sql<{ metric: string; value: number }[]>`SELECT metric, value FROM pmd.dashboard_metric WHERE metric IN ('possible_duplicates','manual_review')`;
    expect(Object.fromEntries(metrics.map((m) => [m.metric, m.value]))).toEqual({ possible_duplicates: 1, manual_review: 1 });
  });

  it("a GTIN collision (same GTIN, contradicting brand) is held for a person - no second master", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "G1", name: "Butter 100 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_100 })]);
    const res = await ingest("test_market_b", [product({ sourceProductId: "G2", name: "Butter 100 g", brand: "Britannia", gtin: GTIN.AMUL_BUTTER_100 })]);
    expect(await count(sql, "pmd.product_master")).toBe(1);
    const [s] = await sql<{ product_id: number | null; resolution: string; match_status: string }[]>`SELECT product_id, resolution, match_status FROM pmd.product_source WHERE source_product_id = 'G2'`;
    expect(s).toMatchObject({ product_id: null, resolution: "PENDING_REVIEW", match_status: "NEEDS_REVIEW" });
    expect(res.counters.reviewQueued).toBe(1);
  });

  it("two workers loading the same brand-new product at once still produce ONE master", async () => {
    const p = (id: string) => product({ sourceProductId: id, name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 });
    await registerTestSource("test_race_a");
    await registerTestSource("test_race_b");
    await Promise.all([ingest("test_race_a", [p("R1")]), ingest("test_race_b", [p("R2")])]);
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.product_source")).toBe(2);
  });
});

describe("incremental updates and price history", () => {
  const listing = (over: { price?: number; seller?: string; when?: string; stock?: string } = {}) =>
    product({
      sourceProductId: "L1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500,
      offer: { sellerName: over.seller ?? "Alpha Traders", price: over.price ?? 250, mrp: 270, stock: over.stock ?? "in stock", collectedAt: over.when ?? "2026-09-01" },
    });

  it("re-running an unchanged feed changes nothing", async () => {
    await ingest("test_market_a", [listing()]);
    const before = { m: await count(sql, "pmd.product_master"), h: await count(sql, "pmd.price_history"), r: await count(sql, "pmd.raw_record") };
    const res = await ingest("test_market_a", [listing()]);
    expect(res.counters).toMatchObject({ recordsUnchanged: 1, productsCreated: 0, priceChanges: 0 });
    expect({ m: await count(sql, "pmd.product_master"), h: await count(sql, "pmd.price_history"), r: await count(sql, "pmd.raw_record") }).toEqual(before);
  });

  it("a price change updates the offer and appends history - the product is untouched", async () => {
    await ingest("test_market_a", [listing({ price: 250, when: "2026-09-01" })]);
    const [before] = await masters();
    const res = await ingest("test_market_a", [listing({ price: 235, when: "2026-09-08" })]);
    expect(res.counters.priceChanges).toBe(1);

    const [offer] = await sql<{ price_minor: number; mrp_minor: number; discount_minor: number; discount_pct: number }[]>`SELECT price_minor, mrp_minor, discount_minor, discount_pct FROM pmd.product_offer`;
    expect(offer).toMatchObject({ price_minor: 23500, mrp_minor: 27000, discount_minor: 3500, discount_pct: 12.96 });
    const hist = await sql<{ selling_price_minor: number; change_reason: string; collection_date: string }[]>`
      SELECT selling_price_minor, change_reason, collection_date FROM pmd.price_history ORDER BY collected_at`;
    expect(hist).toEqual([
      { selling_price_minor: 25000, change_reason: "FIRST_SEEN", collection_date: "2026-09-01" },
      { selling_price_minor: 23500, change_reason: "PRICE_CHANGED", collection_date: "2026-09-08" },
    ]);
    const [after] = await masters();
    expect(after.version).toBe(before.version);
  });

  it("an unchanged price on a later date writes no history row", async () => {
    await ingest("test_market_a", [listing({ when: "2026-09-01" })]);
    await ingest("test_market_a", [listing({ when: "2026-09-08" })]);
    expect(await count(sql, "pmd.price_history")).toBe(1);
    const [o] = await sql<{ collection_date: string }[]>`SELECT collection_date FROM pmd.product_offer`;
    expect(o.collection_date).toBe("2026-09-08");
  });

  it("a new seller is a new offer on the same product", async () => {
    await ingest("test_market_a", [listing({ seller: "Alpha Traders" })]);
    await ingest("test_market_a", [listing({ seller: "Beta Stores", price: 240 })]);
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.product_offer")).toBe(2);
    expect(await count(sql, "pmd.price_history")).toBe(2);
  });

  it("an older observation never rolls the current price back - it backfills history once", async () => {
    await ingest("test_market_a", [listing({ price: 235, when: "2026-09-08" })]);
    await ingest("test_market_a", [listing({ price: 250, when: "2026-09-01" })]);
    await ingest("test_market_a", [listing({ price: 250, when: "2026-09-01" })]);
    const [o] = await sql<{ price_minor: number }[]>`SELECT price_minor FROM pmd.product_offer`;
    expect(o.price_minor).toBe(23500);
    const hist = await sql<{ selling_price_minor: number }[]>`SELECT selling_price_minor FROM pmd.price_history ORDER BY collected_at`;
    expect(hist.map((h) => h.selling_price_minor)).toEqual([25000, 23500]);
  });

  it("an implausible price jump is recorded but flagged for a person (67 -> 1)", async () => {
    await ingest("test_market_a", [listing({ price: 67, when: "2026-09-01" })]);
    await ingest("test_market_a", [listing({ price: 1, when: "2026-09-02" })]);
    expect(await count(sql, "pmd.price_history")).toBe(2);
    expect(await count(sql, "pmd.import_error", "error_code = 'PRICE_OUTLIER' AND severity = 'WARNING'")).toBe(1);
    // an ordinary move is not flagged
    await ingest("test_market_a", [listing({ price: 1.2, when: "2026-09-03" })]);
    expect(await count(sql, "pmd.import_error", "error_code = 'PRICE_OUTLIER'")).toBe(1);
  });

  it("history is append-only: nothing is deleted when prices change many times", async () => {
    for (const [i, price] of [250, 240, 230, 260, 255].entries()) await ingest("test_market_a", [listing({ price, when: `2026-09-0${i + 1}` })]);
    expect(await count(sql, "pmd.price_history")).toBe(5);
  });

  it("supports lowest / highest / average analysis from history", async () => {
    for (const [i, price] of [250, 230, 260].entries()) await ingest("test_market_a", [listing({ price, when: `2026-09-0${i + 1}` })]);
    const [s] = await sql<{ lo: number; hi: number; avg: number }[]>`SELECT min(selling_price_minor) lo, max(selling_price_minor) hi, round(avg(selling_price_minor)) avg FROM pmd.price_history`;
    expect(s).toEqual({ lo: 23000, hi: 26000, avg: 24667 });
  });
});

describe("availability and status", () => {
  const item = (id: string, stock: string) => product({ sourceProductId: id, name: `Item ${id}`, brand: "Acme", offer: { sellerName: "S", price: 100, stock, collectedAt: "2026-09-01" } });

  it("derives ACTIVE / OUT_OF_STOCK from offers", async () => {
    await ingest("test_market_a", [item("X1", "in stock"), item("X2", "out of stock"), item("X3", "???")]);
    const rows = await sql<{ product_name: string; product_status: string }[]>`SELECT product_name, product_status FROM pmd.product_master ORDER BY product_name`;
    expect(rows).toEqual([
      { product_name: "Item X1", product_status: "ACTIVE" },
      { product_name: "Item X2", product_status: "OUT_OF_STOCK" },
      { product_name: "Item X3", product_status: "UNKNOWN" },
    ]);
  });

  it("a product missing from a COMPLETE snapshot becomes TEMPORARILY_UNAVAILABLE - never DISCONTINUED", async () => {
    await ingest("test_market_a", [item("Y1", "in stock"), item("Y2", "in stock")], { fullSnapshot: true });
    await ingest("test_market_a", [item("Y1", "in stock")], { fullSnapshot: true });
    const rows = await sql<{ product_name: string; product_status: string; status_basis: string }[]>`SELECT product_name, product_status, status_basis FROM pmd.product_master ORDER BY product_name`;
    expect(rows[0]).toMatchObject({ product_name: "Item Y1", product_status: "ACTIVE" });
    expect(rows[1]).toMatchObject({ product_name: "Item Y2", product_status: "TEMPORARILY_UNAVAILABLE", status_basis: "NO_CURRENT_OFFERS" });
    const [o] = await sql<{ is_current: boolean }[]>`SELECT is_current FROM pmd.product_offer WHERE source_product_id = 'Y2'`;
    expect(o.is_current).toBe(false);
    expect(await count(sql, "pmd.product_master", "product_status = 'DISCONTINUED'")).toBe(0);
  });

  it("a partial run (a pilot with a limit) never concludes anything is missing", async () => {
    await ingest("test_market_a", [item("Z1", "in stock"), item("Z2", "in stock")], { fullSnapshot: true });
    await ingest("test_market_a", [item("Z1", "in stock")], { fullSnapshot: false });
    expect(await count(sql, "pmd.product_offer", "is_current")).toBe(2);
  });

  it("a person's DISCONTINUED decision is never overwritten by the pipeline", async () => {
    await ingest("test_market_a", [item("D1", "in stock")]);
    await sql`UPDATE pmd.product_master SET product_status = 'DISCONTINUED', status_basis = 'MANUFACTURER_STATEMENT'`;
    await ingest("test_market_a", [{ ...item("D1", "in stock"), offer: { sellerName: "S", price: 90, stock: "in stock", collectedAt: "2026-09-05" } }]);
    const [m] = await masters();
    expect(m.product_status).toBe("DISCONTINUED");
  });
});

describe("specification conflicts", () => {
  const phone = (id: string, extra: Record<string, unknown> = {}) =>
    product({ sourceProductId: id, name: "Galaxy S23", brand: "Samsung", model: "SM-S911B", gtin: GTIN.PHONE_BLACK, ...extra });

  it("manufacturer data beats a marketplace - the conflict is recorded, not silently overwritten", async () => {
    await ingest("test_market_a", [phone("M1", { gstRate: "12%" })]);
    await ingest("test_brand_feed", [phone("B1", { gstRate: "18%" })], { kind: "BRAND_MANUFACTURER" });
    expect((await sql<{ gst_rate_bp: number }[]>`SELECT gst_rate_bp FROM pmd.product_master`)[0].gst_rate_bp).toBe(1800);
    const [c] = await sql<{ conflict_status: string; value_1: string; source_1: string; value_2: string; source_2: string; resolution: string }[]>`
      SELECT conflict_status, value_1, source_1, value_2, source_2, resolution FROM pmd.product_attribute_conflict WHERE attribute_key = 'gst_rate_bp'`;
    expect(c).toMatchObject({ conflict_status: "AUTO_RESOLVED", value_1: "1800 bp", source_1: "test_brand_feed", value_2: "1200 bp", source_2: "test_market_a" });
    expect(c.resolution).toMatch(/precedence/);
    // Both values remain, each with its source.
    const specs = await sql<{ source_key: string; value_num: number; is_preferred: boolean }[]>`
      SELECT s.source_key, sp.value_num, sp.is_preferred FROM pmd.product_specification sp JOIN pmd.source s USING (source_id) WHERE sp.attribute_key = 'gst_rate_bp' ORDER BY s.source_key`;
    expect(specs).toEqual([
      { source_key: "test_brand_feed", value_num: 1800, is_preferred: true },
      { source_key: "test_market_a", value_num: 1200, is_preferred: false },
    ]);
  });

  it("the outcome does not depend on which source arrived first", async () => {
    await ingest("test_brand_feed", [phone("B1", { gstRate: "18%" })], { kind: "BRAND_MANUFACTURER" });
    await ingest("test_market_a", [phone("M1", { gstRate: "12%" })]);
    expect((await sql<{ gst_rate_bp: number }[]>`SELECT gst_rate_bp FROM pmd.product_master`)[0].gst_rate_bp).toBe(1800);
    expect(await count(sql, "pmd.product_attribute_conflict", "conflict_status = 'AUTO_RESOLVED'")).toBe(1);
  });

  it("the same GTIN with a contradicting COLOUR is a collision for review, not a spec conflict", async () => {
    await ingest("test_market_a", [phone("M1", { color: "Blue" })]);
    await ingest("test_brand_feed", [phone("B1", { color: "Black" })], { kind: "BRAND_MANUFACTURER" });
    expect(await count(sql, "pmd.product_master")).toBe(1);
    const [s] = await sql<{ product_id: number | null; resolution: string }[]>`SELECT product_id, resolution FROM pmd.product_source WHERE source_product_id = 'B1'`;
    expect(s).toMatchObject({ product_id: null, resolution: "PENDING_REVIEW" });
  });
  it("equally authoritative sources that disagree leave an OPEN conflict and the value in force does not flip", async () => {
    await ingest("test_market_a", [phone("M1", { material: "Polycarbonate" })]);
    const res = await ingest("test_market_b", [phone("M2", { material: "Metal" })]);
    expect(res.counters.conflictsOpened).toBe(1);
    const [m] = await masters();
    expect(m.material).toBe("Polycarbonate");
    expect(await count(sql, "pmd.product_attribute_conflict", "conflict_status = 'OPEN'")).toBe(1);
    const dash = await sql<{ value: number }[]>`SELECT value FROM pmd.dashboard_metric WHERE metric = 'conflicting_specs'`;
    expect(dash[0].value).toBe(1);
  });

  it("a conflict closes itself when the sources converge", async () => {
    await ingest("test_market_a", [phone("M1", { material: "Polycarbonate" })]);
    await ingest("test_market_b", [phone("M2", { material: "Metal" })]);
    await ingest("test_market_b", [phone("M2", { material: "Polycarbonate" })]);
    expect(await count(sql, "pmd.product_attribute_conflict", "conflict_status = 'OPEN'")).toBe(0);
    const [c] = await sql<{ resolution: string }[]>`SELECT resolution FROM pmd.product_attribute_conflict ORDER BY conflict_id LIMIT 1`;
    expect(c.resolution).toMatch(/no longer differ|now agree/);
  });

  it("exactly one preferred value exists per product and attribute", async () => {
    await ingest("test_market_a", [phone("M1", { gstRate: "12%", material: "Metal" })]);
    await ingest("test_brand_feed", [phone("B1", { gstRate: "18%", material: "Metal" })], { kind: "BRAND_MANUFACTURER" });
    const rows = await sql<{ n: number }[]>`SELECT count(*) FILTER (WHERE is_preferred)::int AS n FROM pmd.product_specification GROUP BY product_id, attribute_key`;
    expect(rows.every((r) => r.n === 1)).toBe(true);
  });

  it("category-specific attributes are stored per source without new columns", async () => {
    await ingest("test_brand_feed", [phone("B1", { attributes: [
      { key: "ram_gb", value: "8 GB" }, { key: "storage_gb", value: 256 }, { key: "display_size_in", value: "6.1" }, { key: "battery_capacity_mah", value: 3900 },
      { key: "some_new_vendor_field", value: "abc" },
    ] })], { kind: "BRAND_MANUFACTURER" });
    const rows = await sql<{ attribute_key: string; value_num: number | null; value_text: string | null }[]>`
      SELECT attribute_key, value_num, value_text FROM pmd.product_specification WHERE attribute_key IN ('ram_gb','storage_gb','display_size_in','battery_capacity_mah','some_new_vendor_field') ORDER BY attribute_key`;
    expect(rows.find((r) => r.attribute_key === "ram_gb")?.value_num).toBe(8);
    expect(rows.find((r) => r.attribute_key === "storage_gb")?.value_num).toBe(256);
    expect(rows.find((r) => r.attribute_key === "some_new_vendor_field")?.value_text).toBe("abc");
    expect(await count(sql, "pmd.attribute_definition", "attribute_key = 'some_new_vendor_field' AND attribute_group = 'OTHER'")).toBe(1);
  });
});

describe("errors, warnings and data-collection log", () => {
  it("bad records land in IMPORT_ERRORS and never stop the run", async () => {
    const res = await ingest("test_market_a", [
      product({ sourceProductId: "E1", name: "Good Item", brand: "Acme" }),
      product({ sourceProductId: "E2", name: "" }),
      product({ sourceProductId: "E3", name: "Bad Barcode", brand: "Acme", gtin: "8901058895781" }),
      product({ sourceProductId: "E4", name: "Bad Tax", brand: "Acme", gstRate: "abc", hsnCode: "12" }),
      product({ sourceProductId: "E5", name: "Bad Price", brand: "Acme", offer: { price: "free", sellerName: "S" } }),
    ]);
    expect(res.status).toBe("PARTIAL");
    expect(await count(sql, "pmd.product_master")).toBe(4);
    const errs = await sql<{ source_record_id: string; error_code: string; severity: string; stage: string }[]>`
      SELECT source_record_id, error_code, severity, stage FROM pmd.import_error ORDER BY source_record_id, error_code`;
    expect(errs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_record_id: "E2", error_code: "NAME_MISSING", severity: "ERROR" }),
      expect.objectContaining({ source_record_id: "E3", error_code: "GTIN_CHECK_DIGIT_INVALID", severity: "WARNING", stage: "NORMALIZE" }),
      expect.objectContaining({ source_record_id: "E4", error_code: "GST_RATE_INVALID" }),
      expect.objectContaining({ source_record_id: "E4", error_code: "HSN_INVALID" }),
      expect.objectContaining({ source_record_id: "E5", error_code: "PRICE_UNPARSEABLE" }),
    ]));
    // An invalid barcode is kept as an opaque source code, never trusted as identity.
    const [id] = await sql<{ id_type: string; check_digit_valid: boolean }[]>`
      SELECT id_type, check_digit_valid FROM pmd.product_identifier i JOIN pmd.product_master pm USING (product_id) WHERE pm.product_name = 'Bad Barcode'`;
    expect(id).toEqual({ id_type: "SOURCE_CODE", check_digit_valid: false });
    expect(await count(sql, "pmd.product_master", "gtin IS NOT NULL")).toBe(0);
  });

  it("an adapter's own parse failure is logged as a PARSE error and the run continues", async () => {
    const res = await ingest("test_market_a", [product({ sourceProductId: "OK", name: "Fine", brand: "Acme" }), product({ sourceProductId: "BAD", name: "Broken" })], {
      adapterOverride: {
        parse: (raw) => {
          if (raw.sourceProductId === "BAD") throw new ParseError("UNREADABLE", "Cannot read this row.");
          return raw.payload as never;
        },
      },
    });
    expect(res.counters.errorCount).toBe(1);
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.import_error", "stage = 'PARSE' AND error_code = 'UNREADABLE'")).toBe(1);
  });

  it("a nameless price record still attaches to a product we already know by GTIN", async () => {
    await ingest("test_brand_feed", [product({ sourceProductId: "K1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })], { kind: "BRAND_MANUFACTURER" });
    const res = await ingest("test_prices", [{ sourceProductId: GTIN.AMUL_BUTTER_500, name: null, gtin: GTIN.AMUL_BUTTER_500, offer: { sellerName: "Corner Shop", price: 255, collectedAt: "2026-09-10" } }], { kind: "OPEN_DATA" });
    expect(res.counters.errorCount).toBe(0);
    expect(await count(sql, "pmd.product_master")).toBe(1);
    expect(await count(sql, "pmd.product_offer")).toBe(1);
  });

  it("a nameless record for an UNKNOWN product is rejected, not invented", async () => {
    const res = await ingest("test_prices", [{ sourceProductId: "0000", name: null, gtin: GTIN.TEA, offer: { sellerName: "S", price: 10 } }], { kind: "OPEN_DATA" });
    expect(await count(sql, "pmd.product_master")).toBe(0);
    expect(res.counters.errorCount).toBe(1);
  });

  it("a price-only source (createsProducts: false) prices what exists and never mints a master", async () => {
    await ingest("test_brand_feed", [product({ sourceProductId: "K1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })], { kind: "BRAND_MANUFACTURER" });
    const res = await ingest("test_price_only", [
      product({ sourceProductId: "P1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, offer: { sellerName: "Corner Shop", price: 255, collectedAt: "2026-09-10" } }),
      product({ sourceProductId: "P2", name: "Some Unknown Tea 250 g", brand: "Nobody", gtin: GTIN.TEA, offer: { sellerName: "Corner Shop", price: 90, collectedAt: "2026-09-10" } }),
    ], { adapterOverride: { createsProducts: false } });

    expect(res.counters).toMatchObject({ productsLinked: 1, productsCreated: 0, errorCount: 1 });
    expect(await count(sql, "pmd.product_master")).toBe(1); // the unknown tea was NOT invented
    expect(await count(sql, "pmd.product_offer")).toBe(1);   // the known butter WAS priced
    const [e] = await sql<{ source_record_id: string; error_code: string; stage: string; severity: string }[]>`
      SELECT source_record_id, error_code, stage, severity FROM pmd.import_error`;
    expect(e).toEqual({ source_record_id: "P2", error_code: "NO_MASTER_TO_ATTACH", stage: "MATCH", severity: "ERROR" });
  });

  it("logs every run: source, mode, counters, timestamps", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "L1", name: "Log Item", brand: "Acme" })]);
    const [r] = await sql<{ run_mode: string; status: string; records_read: number; products_created: number; finished_at: Date | null; started_at: Date }[]>`
      SELECT run_mode, status, records_read, products_created, finished_at, started_at FROM pmd.ingestion_run`;
    expect(r).toMatchObject({ run_mode: "INCREMENTAL", status: "SUCCEEDED", records_read: 1, products_created: 1 });
    expect(r.finished_at).not.toBeNull();
    const [s] = await sql<{ last_success_at: Date | null; last_run_products: number }[]>`SELECT last_success_at, last_run_products FROM pmd.source WHERE source_key = 'test_market_a'`;
    expect(s.last_success_at).not.toBeNull();
    expect(s.last_run_products).toBe(1);
  });
});

describe("governance: history, versions, integrity", () => {
  it("field changes write a change log and bump the version; identical re-loads do not", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "H1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })]);
    const [v1] = await masters();
    await ingest("test_brand_feed", [product({ sourceProductId: "H2", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, description: "Pasteurised table butter." })], { kind: "BRAND_MANUFACTURER" });
    const [v2] = await masters();
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.description).toBe("Pasteurised table butter.");
    const log = await sql<{ field_name: string; changed_by: string }[]>`SELECT field_name, changed_by FROM pmd.product_change_log WHERE product_id = ${v1.product_id} ORDER BY change_id`;
    expect(log.map((l) => l.field_name)).toEqual(expect.arrayContaining(["created", "long_description"]));
    await ingest("test_brand_feed", [product({ sourceProductId: "H2", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, description: "Pasteurised table butter." })], { kind: "BRAND_MANUFACTURER" });
    expect((await masters())[0].version).toBe(v2.version);
  });

  it("a better source replaces a field; a weaker source never overwrites a better one", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "S1", name: "Butter", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, description: "marketplace text" })]);
    await ingest("test_brand_feed", [product({ sourceProductId: "S2", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, description: "manufacturer text" })], { kind: "BRAND_MANUFACTURER" });
    expect((await masters())[0].description).toBe("manufacturer text");
    await ingest("test_market_a", [product({ sourceProductId: "S1", name: "Butter", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, description: "marketplace text v2" })]);
    expect((await masters())[0].description).toBe("manufacturer text");
  });

  it("the database refuses duplicate active GTINs and negative prices", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "I1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 })]);
    await expect(sql`INSERT INTO pmd.product_master (gtin, product_name, normalized_name, search_text) VALUES (${"0" + GTIN.AMUL_BUTTER_500}, 'dup', 'dup', 'dup')`).rejects.toThrow(/product_master_gtin_uq/);
    await expect(sql`INSERT INTO pmd.product_offer (product_source_id, source_id, source_product_id, seller_key, price_minor, collection_date, collected_at)
                     SELECT product_source_id, source_id, 'x', 'neg', -1, current_date, now() FROM pmd.product_source LIMIT 1`).rejects.toThrow(/check/);
  });

  it("MASTER_PRODUCT_ID cannot be supplied or duplicated - it is generated", async () => {
    await expect(sql`INSERT INTO pmd.product_master (master_product_id, product_name, normalized_name, search_text) VALUES ('GKS-PROD-000000001', 'x', 'x', 'x')`).rejects.toThrow(/non-DEFAULT value/);
  });

  it("the dashboard snapshot matches the data", async () => {
    await ingest("test_market_a", [
      product({ sourceProductId: "D1", name: "Item One", brand: "Acme", gtin: GTIN.TEA }),
      product({ sourceProductId: "D2", name: "Item Two" }),
    ]);
    const m = Object.fromEntries((await sql<{ metric: string; dimension: string; value: number }[]>`SELECT metric, dimension, value FROM pmd.dashboard_metric`).map((r) => [`${r.metric}|${r.dimension}`, r.value]));
    expect(m["total_products|"]).toBe(2);
    expect(m["missing_gtin|"]).toBe(1);
    expect(m["missing_brand|"]).toBe(1);
    expect(m["missing_category|"]).toBe(2);
    expect(m["missing_mrp|"]).toBe(2);
    expect(m["by_marketplace|test_market_a"]).toBe(2);
  });
});

describe("work queue", () => {
  it("concurrent workers never claim the same job (SKIP LOCKED)", async () => {
    for (let i = 0; i < 12; i++) await sql`INSERT INTO pmd.job (job_type, payload) VALUES ('ingest_batch', ${sql.json({ i } as never)})`;
    const claims = await Promise.all(Array.from({ length: 8 }, (_, w) => sql<{ job_id: number }[]>`SELECT job_id FROM pmd.claim_job(ARRAY['ingest_batch'], ${"worker-" + w})`));
    const ids = claims.flat().map((r) => r.job_id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(await count(sql, "pmd.job", "status = 'RUNNING'")).toBe(8);
  });

  it("abandoned jobs are re-claimable and dead-lettered after max attempts", async () => {
    await sql`INSERT INTO pmd.job (job_type, max_attempts, status, attempts, locked_at) VALUES ('t', 2, 'RUNNING', 1, now() - interval '1 hour')`;
    const [a] = await sql<{ attempts: number }[]>`SELECT attempts FROM pmd.claim_job(ARRAY['t'], 'w1')`;
    expect(a.attempts).toBe(2);
    await sql`UPDATE pmd.job SET locked_at = now() - interval '1 hour'`;
    expect(await sql`SELECT 1 FROM pmd.claim_job(ARRAY['t'], 'w2')`).toHaveLength(0);
  });
});
