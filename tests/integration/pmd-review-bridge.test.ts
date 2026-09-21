/**
 * Product Master Data Platform - review & merge, the catalogue bridge, and the
 * automated data-quality / duplicate checks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { failedInvariants, runChecks } from "@/server/pmd/pipeline/checks";
import { decideCandidate, mergeProducts, ReviewError, type ReviewActor } from "@/server/pmd/pipeline/review";
import { catalogueGtin, gtinForms, promoteToCatalogue, PromotionError, shopsSellingMasterProduct } from "@/server/pmd/services/catalogue-bridge";
import { createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";
import { count, GTIN, ingest, pmdSql, product, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const steward: ReviewActor = { userId: null, label: "steward@test.local" };

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  await resetDatabase();
  await resetPmd();
});

const idOf = async (name: string) => (await sql<{ product_id: number }[]>`SELECT product_id FROM pmd.product_master WHERE product_name = ${name}`)[0].product_id;
const masterIdOf = async (name: string) => (await sql<{ master_product_id: string }[]>`SELECT master_product_id FROM pmd.product_master WHERE product_name = ${name}`)[0].master_product_id;

describe("review queue: resolving possible duplicates", () => {
  const twoSpellings = async () => {
    await ingest("test_market_a", [product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul", offer: { sellerName: "Alpha", price: 66, stock: "in stock", collectedAt: "2026-09-01" } })]);
    await ingest("test_market_b", [product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul", offer: { sellerName: "Beta", price: 65, stock: "in stock", collectedAt: "2026-09-02" }, attributes: [{ key: "material", value: "Pouch" }] })]);
    const [c] = await sql<{ candidate_id: number }[]>`SELECT candidate_id FROM pmd.match_candidate WHERE review_status = 'PENDING'`;
    return c.candidate_id;
  };

  it("CONFIRMED_SAME merges into the older master by pointer - nothing is deleted", async () => {
    const candidateId = await twoSpellings();
    const older = await idOf("Amul Taaza Toned Milk 1 L");
    const result = await decideCandidate(sql, candidateId, "CONFIRMED_SAME", steward, "Same milk, spelling variant");

    expect(result.merged).toMatchObject({ intoProductId: older, sourcesMoved: 1, offersMoved: 1, historyRowsMoved: 1 });
    expect(await count(sql, "pmd.product_master", "record_status = 'ACTIVE'")).toBe(1);
    const [retired] = await sql<{ record_status: string; merged_into_product_id: number }[]>`SELECT record_status, merged_into_product_id FROM pmd.product_master WHERE record_status = 'MERGED'`;
    expect(retired).toEqual({ record_status: "MERGED", merged_into_product_id: older });

    // One master now carries both source records, both sellers' offers and the whole price history.
    expect(await count(sql, "pmd.product_source", `product_id = ${older}`)).toBe(2);
    expect(await count(sql, "pmd.product_offer", `product_id = ${older}`)).toBe(2);
    expect(await count(sql, "pmd.price_history", `product_id = ${older}`)).toBe(2);
    expect(await count(sql, "pmd.product_master")).toBe(2); // the retired row still exists

    const [log] = await sql<{ merged_by: string; reason: string }[]>`SELECT merged_by, reason FROM pmd.product_merge_log`;
    expect(log).toEqual({ merged_by: "steward@test.local", reason: "Same milk, spelling variant" });
    const [cand] = await sql<{ review_status: string; reviewed_at: Date | null }[]>`SELECT review_status, reviewed_at FROM pmd.match_candidate`;
    expect(cand.review_status).toBe("CONFIRMED_SAME");
    expect(cand.reviewed_at).not.toBeNull();
    expect(await failedInvariants(sql)).toEqual([]);
  });

  it("the merged product is one item with a single status and quality recomputed", async () => {
    const candidateId = await twoSpellings();
    await decideCandidate(sql, candidateId, "CONFIRMED_SAME", steward);
    const [m] = await sql<{ product_status: string; data_quality_score: number; version: number }[]>`SELECT product_status, data_quality_score, version FROM pmd.product_master WHERE record_status = 'ACTIVE'`;
    expect(m.product_status).toBe("ACTIVE");
    expect(m.data_quality_score).toBeGreaterThan(0);
    expect(m.version).toBeGreaterThan(1);
    const dash = await sql<{ metric: string; value: number }[]>`SELECT metric, value FROM pmd.dashboard_metric WHERE metric IN ('possible_duplicates','duplicates_merged')`;
    expect(Object.fromEntries(dash.map((d) => [d.metric, d.value]))).toEqual({ possible_duplicates: 0, duplicates_merged: 1 });
  });

  it("CONFIRMED_DIFFERENT closes the item and merges nothing", async () => {
    const candidateId = await twoSpellings();
    await decideCandidate(sql, candidateId, "CONFIRMED_DIFFERENT", steward);
    expect(await count(sql, "pmd.product_master", "record_status = 'ACTIVE'")).toBe(2);
    expect(await count(sql, "pmd.match_candidate", "review_status = 'PENDING'")).toBe(0);
    expect(await count(sql, "pmd.product_merge_log")).toBe(0);
  });

  it("SAME_FAMILY groups two products of one line without merging them", async () => {
    const candidateId = await twoSpellings();
    await decideCandidate(sql, candidateId, "SAME_FAMILY", steward);
    const fams = await sql<{ product_family_id: number | null }[]>`SELECT product_family_id FROM pmd.product_master`;
    expect(new Set(fams.map((f) => f.product_family_id)).size).toBe(1);
    expect(fams[0].product_family_id).not.toBeNull();
    expect(await count(sql, "pmd.product_master", "record_status = 'ACTIVE'")).toBe(2);
  });

  it("a decision can only be taken once", async () => {
    const candidateId = await twoSpellings();
    await decideCandidate(sql, candidateId, "CONFIRMED_DIFFERENT", steward);
    await expect(decideCandidate(sql, candidateId, "CONFIRMED_SAME", steward)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });

  it("refuses to merge a product into itself or a retired product", async () => {
    const candidateId = await twoSpellings();
    const a = await idOf("Amul Taaza Toned Milk 1 L");
    const b = await idOf("Amul Taza Toned Milk 1 L");
    await expect(mergeProducts(sql, a, a, steward, null)).rejects.toBeInstanceOf(ReviewError);
    await decideCandidate(sql, candidateId, "CONFIRMED_SAME", steward);
    await expect(mergeProducts(sql, b, a, steward, null)).rejects.toMatchObject({ code: "NOT_ACTIVE" });
  });

  it("a merge keeps every identifier and re-resolves specification conflicts", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "X1", name: "Item Alpha 500 g", brand: "Acme", gtin: GTIN.TEA, attributes: [{ key: "material", value: "Steel" }] })]);
    await ingest("test_market_b", [product({ sourceProductId: "X2", name: "Item Alfa 500 g", brand: "Acme", gtin: GTIN.MILK_1L, attributes: [{ key: "material", value: "Plastic" }] })]);
    const a = await idOf("Item Alpha 500 g");
    const b = await idOf("Item Alfa 500 g");
    await mergeProducts(sql, b, a, steward, "manual");
    const idents = await sql<{ id_value: string }[]>`SELECT id_value FROM pmd.product_identifier WHERE product_id = ${a} AND id_type = 'GTIN' ORDER BY id_value`;
    expect(idents.map((i) => i.id_value).sort()).toEqual([`0${GTIN.MILK_1L}`, `0${GTIN.TEA}`].sort());
    expect(await count(sql, "pmd.product_identifier", `product_id = ${a} AND is_primary`)).toBe(1);
    expect(await count(sql, "pmd.product_attribute_conflict", "attribute_key = 'material' AND conflict_status = 'OPEN'")).toBe(1);
    expect(await count(sql, "pmd.product_specification", `product_id = ${a} AND attribute_key = 'material' AND is_preferred`)).toBe(1);
    expect(await failedInvariants(sql)).toEqual([]);
  });

  it("confirming a HELD GTIN collision links the record; the source's next run enriches it", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "G1", name: "Butter 100 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_100 })]);
    const row = product({ sourceProductId: "G2", name: "Butter 100 g", brand: "Britannia", gtin: GTIN.AMUL_BUTTER_100, offer: { sellerName: "Corner", price: 55, stock: "in stock", collectedAt: "2026-09-05" } });
    await ingest("test_market_b", [row]);
    expect(await count(sql, "pmd.product_offer")).toBe(0);
    const [c] = await sql<{ candidate_id: number }[]>`SELECT candidate_id FROM pmd.match_candidate WHERE review_status = 'PENDING'`;
    const res = await decideCandidate(sql, c.candidate_id, "CONFIRMED_SAME", steward, "Brand was mis-entered upstream");
    expect(res.linkedHeldRecord).toBe(true);
    const [s] = await sql<{ product_id: number | null; resolution: string }[]>`SELECT product_id, resolution FROM pmd.product_source WHERE source_product_id = 'G2'`;
    expect(s.resolution).toBe("MANUAL_LINK");
    expect(s.product_id).not.toBeNull();
    await ingest("test_market_b", [row]);
    expect(await count(sql, "pmd.product_offer")).toBe(1);
    expect(await count(sql, "pmd.product_master")).toBe(1);
  });
});

describe("catalogue bridge: master product -> GoKesari catalogue -> shops", () => {
  const mapper = createCategoryMapper({ tags: { "en:milks": "dairy/milk" }, keywords: [] });
  const milk = (extra: Partial<Parameters<typeof product>[0]> = {}) =>
    product({
      sourceProductId: "M1",
      name: "Amul Taaza Homogenised Toned Milk 1 L",
      brand: "Amul",
      manufacturer: "Gujarat Co-operative Milk Marketing Federation",
      gtin: GTIN.MILK_1L,
      categories: ["en:milks"],
      gstRate: "5%",
      hsnCode: "0402",
      description: "Homogenised toned milk.",
      ...extra,
    });

  const setup = async (over: Partial<Parameters<typeof product>[0]> = {}, kind: "BRAND_MANUFACTURER" | "MARKETPLACE" = "BRAND_MANUFACTURER") => {
    const admin = await createUser({ role: "ADMIN" });
    await createCategory({ department: "DAIRY", name: "Milk" });
    await ingest(kind === "BRAND_MANUFACTURER" ? "test_brand_feed" : "test_market_a", [milk(over)], { kind, adapterOverride: { categoryMapper: mapper } });
    return { admin, masterId: await masterIdOf("Amul Taaza Homogenised Toned Milk 1 L") };
  };

  it("promotes a master product into the live catalogue with identity and tax intact", async () => {
    const { admin, masterId } = await setup({ offer: { sellerName: "Brand Store", price: 66, mrp: 68, stock: "in stock" } });
    const res = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
    expect(res).toMatchObject({ masterProductId: masterId, adopted: false, created: { product: true, brand: true } });

    const [p] = await sql<Record<string, unknown>[]>`
      SELECT p.name, p.gtin, p.kind, p.net_quantity, p.net_quantity_unit, p.unit, p.gst_rate_bp, p.hsn_code, p.manufacturer_name,
             p.mrp_paise, p.mrp_source, p.mrp_verification_status, p.approval_status, p.created_by, b.name AS brand
      FROM public.products p JOIN public.brands b ON b.id = p.brand_id WHERE p.id = ${res.catalogueProductId}`;
    expect(p).toMatchObject({
      name: "Amul Taaza Homogenised Toned Milk 1 L", gtin: GTIN.MILK_1L, kind: "PACKAGED", net_quantity: 1000, net_quantity_unit: "ml", unit: "L",
      gst_rate_bp: 500, hsn_code: "0402", manufacturer_name: "Gujarat Co-operative Milk Marketing Federation",
      // MRP crosses only from an entitled source, and lands for verification - never pre-verified.
      mrp_paise: 6800, mrp_source: "BRAND", mrp_verification_status: "PENDING_VERIFICATION",
      approval_status: "APPROVED", created_by: admin.id, brand: "Amul",
    });
    const [link] = await sql<{ catalogue_product_id: string }[]>`SELECT catalogue_product_id FROM pmd.catalogue_link`;
    expect(link.catalogue_product_id).toBe(res.catalogueProductId);
    const audit = await sql<{ action: string; actor_id: string }[]>`SELECT action, actor_id FROM public.audit_logs WHERE action = 'pmd.product_promoted'`;
    expect(audit).toEqual([{ action: "pmd.product_promoted", actor_id: admin.id }]);
  });

  const shots = ["https://images.example.org/milk-front.jpg", "https://images.example.org/milk-back.jpg"];
  const promotedImages = async (images: boolean) => {
    const { admin, masterId } = await setup({ images: shots });
    const res = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" }, { images });
    const [p] = await sql<{ image_url: string | null }[]>`SELECT image_url FROM public.products WHERE id = ${res.catalogueProductId}`;
    return [p.image_url, await count(sql, "public.product_images", `product_id = '${res.catalogueProductId}'`)];
  };
  it("links the source's image URLs to the catalogue product by default", async () => {
    expect(await promotedImages(true)).toEqual([shots[0], 1]);
  });
  it("links no images when asked not to", async () => {
    expect(await promotedImages(false)).toEqual([null, 0]);
  });

  describe("rolling a promotion back (scripts/pmd/rollback-promotion.sql)", () => {
    // the script carries its own BEGIN/COMMIT, which postgres.js only allows on a connection reserved for it
    const rollback = async () => {
      const conn = await sql.reserve();
      try {
        await conn.unsafe(readFileSync(join(process.cwd(), "scripts/pmd/rollback-promotion.sql"), "utf8"));
      } finally {
        conn.release();
      }
    };

    it("deletes what promotion created, but never a catalogue product it merely adopted", async () => {
      const { admin, masterId } = await setup(); // milk: created by promotion
      const cat = await createCategory({ department: "COSMETICS_BEAUTY", name: "Personal care" });
      const existing = await createProduct(cat.id, { name: "Kleenex Tissue", unit: "pack", subscribable: false });
      await sql`UPDATE public.products SET gtin = '036000291452' WHERE id = ${existing.id}`;
      await ingest("test_market_a", [product({ sourceProductId: "K1", name: "Kleenex Facial Tissue", brand: "Kleenex", gtin: "0036000291452" })]);
      const [{ master_product_id: kleenex }] = await sql<{ master_product_id: string }[]>`SELECT master_product_id FROM pmd.product_master WHERE product_name ILIKE 'Kleenex%'`;

      const created = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
      const adopted = await promoteToCatalogue(sql, kleenex, { userId: admin.id, role: "ADMIN" });
      expect([created.adopted, adopted.adopted]).toEqual([false, true]);
      expect(await count(sql, "pmd.catalogue_link")).toBe(2);

      await rollback();

      expect(await count(sql, "public.products", `id = '${created.catalogueProductId}'`)).toBe(0); // created: gone
      expect(await count(sql, "public.products", `id = '${existing.id}'`)).toBe(1); // adopted: still there
      expect(await count(sql, "pmd.catalogue_link")).toBe(0);
      expect(await count(sql, "public.audit_logs", "action LIKE 'pmd.product_%'")).toBe(2); // the record stays
      // and the product can be promoted again afterwards (its GTIN is free)
      expect((await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" })).adopted).toBe(false);
    });

    it("keeps a product a shop already sells, and its link", async () => {
      const { admin, masterId } = await setup();
      const res = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
      const owner = await createUser({ role: "SHOP_OWNER" });
      const shop = await createShop(owner.id, { name: "Shop A" });
      await createShopProduct(shop.id, res.catalogueProductId, { onlinePricePaise: 6700, onlineStock: 10 });

      await rollback();

      expect(await count(sql, "public.products", `id = '${res.catalogueProductId}'`)).toBe(1);
      expect(await count(sql, "pmd.catalogue_link")).toBe(1);
      expect(await count(sql, "public.shop_products")).toBe(1);
    });
  });

  it("marketplace seller pricing never becomes GoKesari's MRP", async () => {
    const { admin, masterId } = await setup({ offer: { sellerName: "Random Seller", price: 60, mrp: 90, stock: "in stock" } }, "MARKETPLACE");
    const res = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
    const [p] = await sql<{ mrp_paise: number | null; mrp_source: string | null; mrp_verification_status: string }[]>`SELECT mrp_paise, mrp_source, mrp_verification_status FROM public.products WHERE id = ${res.catalogueProductId}`;
    expect(p).toEqual({ mrp_paise: null, mrp_source: null, mrp_verification_status: "UNVERIFIED" });
  });

  it("two shops select the SAME catalogue product; each keeps its own price and stock", async () => {
    const { admin, masterId } = await setup();
    const res = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(ownerA.id, { name: "Shop A" });
    const shopB = await createShop(ownerB.id, { name: "Shop B" });
    await createShopProduct(shopA.id, res.catalogueProductId, { onlinePricePaise: 6700, onlineStock: 10 });
    await createShopProduct(shopB.id, res.catalogueProductId, { onlinePricePaise: 6900, onlineStock: 25 });

    const sellers = await shopsSellingMasterProduct(sql, masterId);
    expect(sellers.map((s) => [s.shop_name, s.online_price_paise, s.online_stock])).toEqual([["Shop A", 6700, 10], ["Shop B", 6900, 25]]);
    expect(new Set(sellers.map((s) => s.catalogue_product_code)).size).toBe(1);
    expect(await count(sql, "public.products", `gtin = '${GTIN.MILK_1L}'`)).toBe(1);
    // Nothing about a shop's price exists on the master product.
    expect(await count(sql, "information_schema.columns", "table_schema = 'pmd' AND table_name = 'product_master' AND column_name ~ 'price|stock'")).toBe(0);
  });

  it("adopts an existing catalogue product with the same GTIN in ANY written form instead of duplicating it", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const cat = await createCategory({ department: "COSMETICS_BEAUTY", name: "Personal care" });
    const existing = await createProduct(cat.id, { name: "Kleenex Tissue", unit: "pack", subscribable: false });
    await sql`UPDATE public.products SET gtin = '036000291452' WHERE id = ${existing.id}`; // stored as a 12-digit UPC-A

    await ingest("test_market_a", [product({ sourceProductId: "K1", name: "Kleenex Facial Tissue", brand: "Kleenex", gtin: "0036000291452" })]);
    const [{ master_product_id }] = await sql<{ master_product_id: string }[]>`SELECT master_product_id FROM pmd.product_master`;
    const res = await promoteToCatalogue(sql, master_product_id, { userId: admin.id, role: "ADMIN" });
    expect(res).toMatchObject({ adopted: true, catalogueProductId: existing.id });
    expect(await count(sql, "public.products")).toBe(1);
    expect(gtinForms("00036000291452").sort()).toEqual(["0036000291452", "00036000291452", "036000291452"].sort());
    expect(catalogueGtin("00036000291452")).toBe("0036000291452");
  });

  it("refuses ineligible products with the reasons, and writes nothing", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await ingest("test_market_a", [product({ sourceProductId: "U1", name: "Uncategorised Thing", brand: "Acme" })]);
    const masterId = await masterIdOf("Uncategorised Thing");
    // A thin record is refused on quality first...
    const thin = await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" }).catch((e) => e);
    expect(thin).toMatchObject({ code: "NOT_ELIGIBLE" });
    expect((thin as PromotionError).reasons.join(" ")).toMatch(/data-quality score/);
    // ...and even with the quality bar lowered, a product with no standard category cannot be filed.
    await expect(promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" }, { minQuality: 0 })).rejects.toMatchObject({ code: "NOT_ELIGIBLE", reasons: ["no standard category"] });
    expect(await count(sql, "public.products")).toBe(0);
    expect(await count(sql, "public.brands")).toBe(0);
    expect(await count(sql, "pmd.catalogue_link")).toBe(0);
    expect(await count(sql, "public.audit_logs", "action LIKE 'pmd.%'")).toBe(0);
  });

  it("enforces a minimum data-quality score", async () => {
    const { admin, masterId } = await setup();
    await expect(promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" }, { minQuality: 99 })).rejects.toBeInstanceOf(PromotionError);
    expect(await count(sql, "public.products")).toBe(0);
  });

  it("cannot promote the same master twice, or into a department with no marketplace category", async () => {
    const { admin, masterId } = await setup();
    await promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" });
    await expect(promoteToCatalogue(sql, masterId, { userId: admin.id, role: "ADMIN" })).rejects.toMatchObject({ code: "ALREADY_PROMOTED" });

    await resetDatabase();
    await resetPmd();
    const admin2 = await createUser({ role: "ADMIN" });
    await ingest("test_brand_feed", [milk()], { kind: "BRAND_MANUFACTURER", adapterOverride: { categoryMapper: mapper } });
    await expect(promoteToCatalogue(sql, await masterIdOf("Amul Taaza Homogenised Toned Milk 1 L"), { userId: admin2.id, role: "ADMIN" })).rejects.toMatchObject({ code: "NO_OPERATIONAL_CATEGORY" });
  });
});

describe("automated data-quality and duplicate checks", () => {
  it("every invariant holds after a realistic mixed load", async () => {
    await ingest("test_brand_feed", [product({ sourceProductId: "B1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, gstRate: "12%" })], { kind: "BRAND_MANUFACTURER" });
    await ingest("test_market_a", [
      product({ sourceProductId: "A1", name: "AMUL Butter 500g", brand: "Amul India", gtin: GTIN.AMUL_BUTTER_500, gstRate: "5%", offer: { sellerName: "S1", price: 250, mrp: 270, stock: "in stock", collectedAt: "2026-09-01" } }),
      product({ sourceProductId: "A2", name: "Tata Salt 1 kg", brand: "Tata", offer: { sellerName: "S2", price: 28, stock: "out of stock", collectedAt: "2026-09-01" } }),
      product({ sourceProductId: "A3", name: "Tata Salt 500 g", brand: "Tata" }),
      product({ sourceProductId: "A4", name: "", brand: "Bad" }),
    ]);
    const results = await runChecks(sql);
    const bad = results.filter((r) => r.kind === "INVARIANT" && r.violations > 0);
    expect(bad).toEqual([]);
    expect(results.filter((r) => r.kind === "INVARIANT").length).toBeGreaterThanOrEqual(10);
  });

  it("detects a duplicated GTIN if one were ever forced in (the check itself works)", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "D1", name: "Dup Check Item", brand: "Acme", gtin: GTIN.TEA })]);
    expect(await count(sql, "pmd.product_master", "gtin IS NOT NULL")).toBe(1);
    await sql`ALTER TABLE pmd.product_master DISABLE TRIGGER ALL`;
    await sql`DROP INDEX pmd.product_master_gtin_uq`;
    try {
      await sql`INSERT INTO pmd.product_master (gtin, product_name, normalized_name, search_text) SELECT gtin, 'dup', 'dup', 'dup' FROM pmd.product_master LIMIT 1`;
      const failed = await failedInvariants(sql);
      expect(failed.map((f) => f.id)).toContain("unique-active-gtin");
    } finally {
      await sql`DELETE FROM pmd.product_master WHERE product_name = 'dup'`;
      await sql`CREATE UNIQUE INDEX product_master_gtin_uq ON pmd.product_master (gtin) WHERE gtin IS NOT NULL AND record_status = 'ACTIVE'`;
      await sql`ALTER TABLE pmd.product_master ENABLE TRIGGER ALL`;
    }
  });

  it("review checks surface steward work without failing", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul" })]);
    await ingest("test_market_b", [product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul" })]);
    const results = await runChecks(sql, "REVIEW");
    expect(results.find((r) => r.id === "possible-duplicate-pairs")?.violations).toBe(1);
    expect(await failedInvariants(sql)).toEqual([]);
  });
});
