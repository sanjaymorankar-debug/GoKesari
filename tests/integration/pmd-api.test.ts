/**
 * Product Master Data Platform - the REST API and read services.
 *
 * The real route handlers run against the real database. Only the session lookup is
 * replaced; authorisation still goes through the app's actual permission matrix.
 */
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string | null; image: string | null; role: string } }));

vi.mock("@/server/authz/guards", async () => {
  const perms = await vi.importActual<typeof import("@/server/authz/permissions")>("@/server/authz/permissions");
  const errors = await vi.importActual<typeof import("@/lib/errors")>("@/lib/errors");
  return {
    requirePermission: async (permission: import("@/server/authz/permissions").Permission) => {
      if (!state.user) throw errors.unauthenticated();
      if (!perms.can(state.user.role as UserRole, permission)) throw errors.forbidden("You do not have permission to perform this action.");
      return state.user;
    },
  };
});

import { GET as getBrands } from "@/app/api/product-master/brands/route";
import { GET as getCategories } from "@/app/api/product-master/categories/route";
import { GET as getDataQuality } from "@/app/api/product-master/data-quality/route";
import { GET as getManufacturers } from "@/app/api/product-master/manufacturers/route";
import { GET as listProductsRoute } from "@/app/api/product-master/products/route";
import { GET as getProductRoute } from "@/app/api/product-master/products/[id]/route";
import { GET as getOffersRoute } from "@/app/api/product-master/products/[id]/offers/route";
import { GET as getHistoryRoute } from "@/app/api/product-master/products/[id]/price-history/route";
import { POST as promoteRoute } from "@/app/api/product-master/products/[id]/promote/route";
import { POST as importRoute } from "@/app/api/product-master/products/import/route";
import { POST as matchRoute } from "@/app/api/product-master/products/match/route";
import { GET as searchRoute } from "@/app/api/product-master/products/search/route";
import { POST as validateRoute } from "@/app/api/product-master/products/validate/route";
import { GET as reviewList } from "@/app/api/product-master/review/route";
import { POST as reviewDecide } from "@/app/api/product-master/review/[candidateId]/route";
import { createCategoryMapper } from "@/server/pmd/taxonomy/mapper";
import { createCategory, createUser, resetDatabase } from "../helpers/fixtures";
import { count, GTIN, ingest, pmdSql, product, resetPmd, seedReference } from "../helpers/pmd";

const sql = pmdSql();
const BASE = "http://localhost/api/product-master";

const call = async (handler: (...a: never[]) => Promise<Response>, path: string, init: { method?: string; body?: unknown; params?: Record<string, string> } = {}) => {
  const req = new NextRequest(`${BASE}${path}`, {
    method: init.method ?? "GET",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } } : {}),
  });
  const res = await (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req, { params: Promise.resolve(init.params ?? {}) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const signIn = async (role: UserRole) => {
  const u = await createUser({ role });
  state.user = { id: u.id, email: u.email, name: u.name, image: null, role };
  return u;
};

const mapper = createCategoryMapper({ tags: { "en:milks": "dairy/milk" }, keywords: [] });

async function seed() {
  await ingest("test_brand_feed", [
    product({ sourceProductId: "B1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul", manufacturer: "Gujarat Co-operative Milk Marketing Federation", gtin: GTIN.MILK_1L, categories: ["en:milks"], gstRate: "5%", hsnCode: "0402" }),
    product({ sourceProductId: "B2", name: "Galaxy S23 128GB", brand: "Samsung", model: "SM-S911B", gtin: GTIN.PHONE_BLACK, color: "Phantom Black", mpn: "SM-S911BZKDINU" }),
    product({ sourceProductId: "B3", name: "Samsung 55 inch 4K Smart TV", brand: "Samsung", model: "UA55AUE60" }),
    product({ sourceProductId: "B4", name: "Amul Butter 100 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_100 }),
    product({ sourceProductId: "B5", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 }),
  ], { kind: "BRAND_MANUFACTURER", adapterOverride: { categoryMapper: mapper } });
  await ingest("test_market_a", [
    product({ sourceProductId: "A1", name: "AMUL Toned Milk 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, offer: { sellerName: "Alpha", price: 66, mrp: 68, stock: "in stock", collectedAt: "2026-09-01" } }),
    product({ sourceProductId: "A1", name: "AMUL Toned Milk 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, offer: { sellerName: "Alpha", price: 64, mrp: 68, stock: "in stock", collectedAt: "2026-09-08" } }),
    product({ sourceProductId: "A1", name: "AMUL Toned Milk 1 litre", brand: "Amul India", gtin: GTIN.MILK_1L, offer: { sellerName: "Beta", price: 67, mrp: 68, stock: "limited", collectedAt: "2026-09-08" } }),
  ]);
}

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  state.user = null;
  await resetDatabase();
  await resetPmd();
});

const idOf = async (name: string) => (await sql<{ master_product_id: string }[]>`SELECT master_product_id FROM pmd.product_master WHERE product_name = ${name}`)[0].master_product_id;

describe("authentication and authorisation", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const r = await call(listProductsRoute as never, "/products");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it.each(["CUSTOMER", "SHOP_OWNER"] as UserRole[])("keeps %s out of the product master entirely (403)", async (role) => {
    await signIn(role);
    for (const [h, p] of [[listProductsRoute, "/products"], [searchRoute, "/products/search?q=milk"], [getDataQuality, "/data-quality"], [reviewList, "/review"], [getBrands, "/brands"]] as const) {
      expect((await call(h as never, p)).status, p).toBe(403);
    }
  });

  it("lets an operator read and review but not bulk-import", async () => {
    await signIn("OPERATOR");
    expect((await call(listProductsRoute as never, "/products")).status).toBe(200);
    const r = await call(importRoute as never, "/products/import", { method: "POST", body: { rows: [{ sourceProductId: "x", name: "Nope" }] } });
    expect(r.status).toBe(403);
    expect(await count(sql, "pmd.product_master")).toBe(0);
  });
});

describe("read endpoints", () => {
  beforeEach(async () => {
    await seed();
    await signIn("ADMIN");
  });

  it("GET /products paginates with a keyset cursor and never repeats or skips a product", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Awaited<ReturnType<typeof call>> = await call(listProductsRoute as never, `/products?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((i: { masterProductId: string }) => i.masterProductId));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("GET /products filters by brand, category, status and quality", async () => {
    const brand = (await sql<{ brand_code: string }[]>`SELECT brand_code FROM pmd.brand WHERE brand_key = 'samsung'`)[0].brand_code;
    const bySamsung = await call(listProductsRoute as never, `/products?brand=${brand}`);
    expect(bySamsung.body.items.map((i: { productName: string }) => i.productName).sort()).toEqual(["Galaxy S23 128GB", "Samsung 55 inch 4K Smart TV"]);
    const dairy = await call(listProductsRoute as never, "/products?category=dairy");
    expect(dairy.body.items.map((i: { productName: string }) => i.productName)).toEqual(["Amul Taaza Toned Milk 1 L"]);
    expect((await call(listProductsRoute as never, "/products?minQuality=100")).body.items).toHaveLength(0);
    expect((await call(listProductsRoute as never, "/products?hasGtin=false")).body.items).toHaveLength(1);
    expect((await call(listProductsRoute as never, "/products?status=BOGUS")).status).toBe(422);
  });

  it("GET /products/{id} returns the full record with provenance", async () => {
    const id = await idOf("Amul Taaza Toned Milk 1 L");
    const r = await call(getProductRoute as never, `/products/${id}`, { params: { id } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      masterProductId: id, brand: { name: "Amul" }, manufacturer: { name: "Gujarat Co-operative Milk Marketing Federation" },
      category: { code: "dairy/milk" }, productStatus: "ACTIVE",
    });
    expect(r.body.identifiers.find((i: { type: string }) => i.type === "GTIN")).toMatchObject({ value: `0${GTIN.MILK_1L}`, checkDigitValid: true, primary: true });
    expect(r.body.sources.map((s: { source: string }) => s.source).sort()).toEqual(["test_brand_feed", "test_market_a"]);
    expect(r.body.specifications.some((s: { key: string; source: string }) => s.key === "gst_rate_bp" && s.source === "test_brand_feed")).toBe(true);
    expect(r.body.offerSummary).toMatchObject({ offerCount: 2, minPriceMinor: 6400, maxPriceMinor: 6700 });
    expect(r.body.quality.score).toBeGreaterThan(0);
  });

  it("shows the pack-size family on a product's detail", async () => {
    const id = await idOf("Amul Butter 100 g");
    const r = await call(getProductRoute as never, `/products/${id}`, { params: { id } });
    expect(r.body.family.members.map((m: { packSize: string }) => m.packSize).sort()).toEqual(["100 g", "500 g"]);
  });

  it("returns 404 for an unknown product and 422 for a malformed id", async () => {
    expect((await call(getProductRoute as never, "/products/GKS-PROD-999999999", { params: { id: "GKS-PROD-999999999" } })).status).toBe(404);
    expect((await call(getProductRoute as never, "/products/1; DROP TABLE", { params: { id: "1; DROP TABLE" } })).status).toBe(422);
  });

  it("GET /products/{id}/offers lists every seller; ?current=true hides delisted ones", async () => {
    const id = await idOf("Amul Taaza Toned Milk 1 L");
    const r = await call(getOffersRoute as never, `/products/${id}/offers`, { params: { id } });
    expect(r.body.count).toBe(2);
    expect(r.body.offers.map((o: { sellerName: string; priceMinor: number }) => [o.sellerName, o.priceMinor])).toEqual([["Alpha", 6400], ["Beta", 6700]]);
    expect(r.body.offers[0]).toMatchObject({ source: expect.any(String), stockStatus: expect.any(String), isCurrent: true, currency: "INR" });
    expect(Object.keys(r.body.offers[0]).filter((k) => k.includes("_"))).toEqual([]); // camelCase throughout, like every other endpoint
    await sql`UPDATE pmd.product_offer SET is_current = false WHERE seller_name = 'Beta'`;
    expect((await call(getOffersRoute as never, `/products/${id}/offers?current=true`, { params: { id } })).body.count).toBe(1);
  });

  it("GET /products/{id}/price-history returns points and lowest / highest / average", async () => {
    const id = await idOf("Amul Taaza Toned Milk 1 L");
    const r = await call(getHistoryRoute as never, `/products/${id}/price-history`, { params: { id } });
    expect(r.body.summary).toEqual({ observations: 3, lowestMinor: 6400, highestMinor: 6700, averageMinor: 6567 });
    expect(r.body.points.map((p: { changeReason: string }) => p.changeReason)).toEqual(expect.arrayContaining(["FIRST_SEEN", "PRICE_CHANGED"]));
    expect(r.body.points[0]).toMatchObject({ source: expect.any(String), sellingPriceMinor: expect.any(Number), currency: "INR" });
    expect(Object.keys(r.body.points[0]).filter((k) => k.includes("_"))).toEqual([]);
    const ranged = await call(getHistoryRoute as never, `/products/${id}/price-history?from=2026-09-05&to=2026-09-30`, { params: { id } });
    expect(ranged.body.summary.observations).toBe(2);
  });

  it("GET /brands, /manufacturers and /categories", async () => {
    const brands = await call(getBrands as never, "/brands");
    const amul = brands.body.items.find((b: { name: string }) => b.name === "Amul");
    expect(amul).toMatchObject({ productCount: 3, aliases: expect.arrayContaining(["Amul", "Amul India"]) });
    expect((await call(getBrands as never, "/brands?q=sams")).body.items.map((b: { name: string }) => b.name)).toEqual(["Samsung"]);
    expect((await call(getManufacturers as never, "/manufacturers")).body.items[0]).toMatchObject({ name: "Gujarat Co-operative Milk Marketing Federation" });
    const cats = await call(getCategories as never, "/categories?level=1");
    expect(cats.body.categories.find((c: { code: string }) => c.code === "dairy")).toMatchObject({ level: 1, name: "Dairy" });
    const milk = (await call(getCategories as never, "/categories")).body.categories.find((c: { code: string }) => c.code === "dairy/milk");
    expect(milk.productCount).toBe(1);
  });

  it("GET /data-quality reports every dashboard metric from the brief", async () => {
    const r = await call(getDataQuality as never, "/data-quality");
    expect(r.status).toBe(200);
    for (const k of ["total_products", "new_products", "updated_products", "duplicates_merged", "possible_duplicates", "manual_review", "missing_gtin", "missing_brand",
      "missing_manufacturer", "missing_mrp", "missing_gst", "missing_hsn", "missing_category", "conflicting_specs", "avg_quality_score"]) {
      expect(r.body.totals, k).toHaveProperty(k);
    }
    expect(r.body.totals.total_products).toBe(5);
    expect(r.body.totals.missing_gtin).toBe(1);
    expect(r.body.byMarketplace.map((m: { source: string }) => m.source)).toEqual(expect.arrayContaining(["test_brand_feed", "test_market_a"]));
    expect(r.body.byBrand[0]).toMatchObject({ brand: "Amul", count: 3 });
    expect(r.body.recentRuns.length).toBeGreaterThan(0);
  });
});

describe("GET /products/search", () => {
  beforeEach(async () => {
    await seed();
    await signIn("ADMIN");
  });
  const names = (r: { body: Record<string, any> }) => r.body.items.map((i: { productName: string }) => i.productName); // eslint-disable-line @typescript-eslint/no-explicit-any

  it("finds by GTIN in any written form (EAN-13, UPC-style, GTIN-14)", async () => {
    for (const code of [GTIN.MILK_1L, `0${GTIN.MILK_1L}`]) {
      const r = await call(searchRoute as never, `/products/search?q=${code}`);
      expect(names(r)[0], code).toBe("Amul Taaza Toned Milk 1 L");
      expect(r.body.items[0].matchType).toBe("IDENTIFIER");
    }
  });

  it("finds by MPN and model number regardless of punctuation", async () => {
    expect(names(await call(searchRoute as never, "/products/search?q=SM-S911BZKDINU"))[0]).toBe("Galaxy S23 128GB");
    expect(names(await call(searchRoute as never, "/products/search?q=ua55aue60"))[0]).toBe("Samsung 55 inch 4K Smart TV");
  });

  it("'Samsung 55 inch 4K TV' finds the television, ranked above unrelated Samsung products", async () => {
    const r = await call(searchRoute as never, "/products/search?q=Samsung%2055%20inch%204K%20TV");
    expect(names(r)[0]).toBe("Samsung 55 inch 4K Smart TV");
    expect(r.body.items[0].matchType).toBe("KEYWORD");
  });

  it("searches by brand, category words and prefixes", async () => {
    expect(names(await call(searchRoute as never, "/products/search?q=amul%20butt")).sort()).toEqual(["Amul Butter 100 g", "Amul Butter 500 g"]);
    expect(names(await call(searchRoute as never, "/products/search?q=samsung")).sort()).toEqual(["Galaxy S23 128GB", "Samsung 55 inch 4K Smart TV"]);
  });

  it("forgives typos with fuzzy search", async () => {
    const r = await call(searchRoute as never, "/products/search?q=amull%20taza%20toned%20milk");
    expect(names(r)).toContain("Amul Taaza Toned Milk 1 L");
    expect(r.body.items.find((i: { productName: string }) => i.productName === "Amul Taaza Toned Milk 1 L").matchType).toBe("FUZZY");
  });

  it("applies filters together with the query and rejects an empty query", async () => {
    const dairyOnly = await call(searchRoute as never, "/products/search?q=amul&category=dairy");
    expect(names(dairyOnly)).toEqual(["Amul Taaza Toned Milk 1 L"]);
    expect((await call(searchRoute as never, "/products/search?q=")).status).toBe(422);
    expect(names(await call(searchRoute as never, "/products/search?q=zzzzqqq"))).toEqual([]);
  });

  it("is safe against SQL/tsquery metacharacters", async () => {
    for (const q of ["'; DROP TABLE pmd.product_master; --", "amul & | ! ( ) :*", "\\", "a:b"]) {
      expect((await call(searchRoute as never, `/products/search?q=${encodeURIComponent(q)}`)).status, q).toBe(200);
    }
    expect(await count(sql, "pmd.product_master")).toBe(5);
  });
});

describe("validate and match (no writes)", () => {
  beforeEach(async () => {
    await seed();
    await signIn("OPERATOR");
  });

  it("POST /products/validate reports normalisation and every issue without touching the database", async () => {
    const before = await count(sql, "pmd.product_master");
    const r = await call(validateRoute as never, "/products/validate", {
      method: "POST",
      body: { product: { sourceProductId: "v1", name: "Amul Butter 500 g", brand: "AMUL India", gtin: "8901058895781", gstRate: "abc", hsnCode: "12", offer: { price: 120, mrp: 100 } } },
    });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(["GTIN_CHECK_DIGIT_INVALID", "GST_RATE_INVALID", "HSN_INVALID", "PRICE_ABOVE_MRP"]));
    expect(r.body.normalized).toMatchObject({ brand: "AMUL India", packLabel: "500 g", gtinUsableForMatching: false });
    expect((await call(validateRoute as never, "/products/validate", { method: "POST", body: { product: { sourceProductId: "v2", name: "" } } })).body.valid).toBe(false);
    expect(await count(sql, "pmd.product_master")).toBe(before);
  });

  it("POST /products/match explains what would happen: exact GTIN match, family sibling, no match", async () => {
    const before = { m: await count(sql, "pmd.product_master"), s: await count(sql, "pmd.product_source") };

    const same = await call(matchRoute as never, "/products/match", { method: "POST", body: { product: { sourceProductId: "m1", name: "Amul Toned Milk, 1L", brand: "Amul", gtin: GTIN.MILK_1L } } });
    expect(same.body.decision).toMatchObject({ action: "LINK", linksTo: expect.stringMatching(/^GKS-PROD-/) });
    expect(same.body.candidates[0]).toMatchObject({ status: "EXACT_MATCH", rule: "L1_GTIN_BRAND", score: 100 });

    const sibling = await call(matchRoute as never, "/products/match", { method: "POST", body: { product: { sourceProductId: "m2", name: "Amul Butter 250 g", brand: "Amul" } } });
    expect(sibling.body.decision.action).toBe("CREATE");
    expect(sibling.body.candidates.find((c: { packSize: string }) => c.packSize === "100 g")).toMatchObject({ status: "DIFFERENT_PRODUCT", relation: "SAME_FAMILY_DIFFERENT_PACK", hardConflicts: ["PACK_SIZE_DIFFERENT"] });

    const none = await call(matchRoute as never, "/products/match", { method: "POST", body: { product: { sourceProductId: "m3", name: "Completely New Gadget", brand: "Zorblax" } } });
    expect(none.body.decision).toMatchObject({ action: "CREATE", reason: "NO_CANDIDATES" });
    expect(none.body.thresholds).toEqual({ autoMerge: 92, possible: 70 });
    expect({ m: await count(sql, "pmd.product_master"), s: await count(sql, "pmd.product_source") }).toEqual(before);
  });

  it("rejects unknown fields and oversize input with a field-level 422", async () => {
    const r = await call(validateRoute as never, "/products/validate", { method: "POST", body: { product: { sourceProductId: "x", name: "N", gtim: "typo" } } });
    expect(r.status).toBe(422);
    const big = await call(validateRoute as never, "/products/validate", { method: "POST", body: { product: { sourceProductId: "x", name: "N".repeat(501) } } });
    expect(big.status).toBe(422);
  });
});

describe("POST /products/import (admin)", () => {
  it("runs the ordinary pipeline, writes an audit entry, and reports bad rows without failing", async () => {
    const admin = await signIn("ADMIN");
    const r = await call(importRoute as never, "/products/import", {
      method: "POST",
      body: {
        rows: [
          { sourceProductId: "i1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500, categories: ["dairy/butter-and-margarine"], gstRate: "12%", offer: { sellerName: "Corner Shop", price: 255, mrp: 270, stock: "in stock" } },
          { sourceProductId: "i2", name: "", brand: "Nameless" },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.counters).toMatchObject({ recordsRead: 2, productsCreated: 1, errorCount: 1 });
    expect(r.body.status).toBe("PARTIAL");
    const [m] = await sql<{ category_code: string; gst_rate_bp: number }[]>`SELECT c.category_code, pm.gst_rate_bp FROM pmd.product_master pm JOIN pmd.category c USING (category_id)`;
    expect(m).toEqual({ category_code: "dairy/butter-and-margarine", gst_rate_bp: 1200 });
    expect(await count(sql, "pmd.product_offer")).toBe(1);
    expect(await count(sql, "public.audit_logs", `action = 'pmd.products_imported' AND actor_id = '${admin.id}'`)).toBe(1);
    expect(await count(sql, "pmd.ingestion_run", "run_mode = 'IMPORT' AND triggered_by IS NOT NULL")).toBe(1);
  });

  it("is idempotent: importing the same rows again creates nothing new", async () => {
    await signIn("ADMIN");
    const body = { rows: [{ sourceProductId: "i1", name: "Amul Butter 500 g", brand: "Amul", gtin: GTIN.AMUL_BUTTER_500 }] };
    await call(importRoute as never, "/products/import", { method: "POST", body });
    const again = await call(importRoute as never, "/products/import", { method: "POST", body });
    expect(again.body.counters).toMatchObject({ productsCreated: 0, recordsUnchanged: 1 });
    expect(await count(sql, "pmd.product_master")).toBe(1);
  });

  it("rejects an empty or oversize batch", async () => {
    await signIn("ADMIN");
    expect((await call(importRoute as never, "/products/import", { method: "POST", body: { rows: [] } })).status).toBe(422);
    const rows = Array.from({ length: 1001 }, (_, i) => ({ sourceProductId: `r${i}`, name: "x" }));
    expect((await call(importRoute as never, "/products/import", { method: "POST", body: { rows } })).status).toBe(422);
  });
});

describe("review queue and promotion over the API", () => {
  it("lists a possible duplicate and resolves it, with an audit entry", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul" })]);
    await ingest("test_market_b", [product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul" })]);
    const admin = await signIn("OPERATOR");

    const q = await call(reviewList as never, "/review");
    expect(q.body.items).toHaveLength(1);
    const item = q.body.items[0];
    expect(item).toMatchObject({ matchStatus: "POSSIBLE_MATCH", incoming: { source: "test_market_b" }, candidate: { name: "Amul Taaza Toned Milk 1 L" } });

    const bad = await call(reviewDecide as never, `/review/${item.candidateId}`, { method: "POST", body: { decision: "MAYBE" }, params: { candidateId: String(item.candidateId) } });
    expect(bad.status).toBe(422);
    const done = await call(reviewDecide as never, `/review/${item.candidateId}`, { method: "POST", body: { decision: "CONFIRMED_SAME", note: "spelling" }, params: { candidateId: String(item.candidateId) } });
    expect(done.status).toBe(200);
    expect(done.body.merged).toMatchObject({ sourcesMoved: 1 });
    expect((await call(reviewList as never, "/review")).body.items).toHaveLength(0);
    expect(await count(sql, "public.audit_logs", `action = 'pmd.match_decided' AND actor_id = '${admin.id}'`)).toBe(1);

    const again = await call(reviewDecide as never, `/review/${item.candidateId}`, { method: "POST", body: { decision: "CONFIRMED_SAME" }, params: { candidateId: String(item.candidateId) } });
    expect(again.status).toBe(409);
    expect((await call(reviewDecide as never, "/review/abc", { method: "POST", body: { decision: "CONFIRMED_SAME" }, params: { candidateId: "abc" } })).status).toBe(422);
  });

  it("promotes a product into the catalogue, then refuses to do it twice or for an ineligible product", async () => {
    await createCategory({ department: "DAIRY", name: "Milk" });
    await ingest("test_brand_feed", [
      product({ sourceProductId: "B1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul", manufacturer: "Gujarat Co-operative Milk Marketing Federation", gtin: GTIN.MILK_1L, categories: ["en:milks"], gstRate: "5%", hsnCode: "0402", description: "Toned milk", images: ["https://img.example.org/m.jpg"], attributes: [{ key: "ingredients", value: "Milk" }] }),
      product({ sourceProductId: "B2", name: "Thing With No Category", brand: "Acme" }),
    ], { kind: "BRAND_MANUFACTURER", adapterOverride: { categoryMapper: mapper } });
    await signIn("OPERATOR");
    const id = await idOf("Amul Taaza Toned Milk 1 L");

    const r = await call(promoteRoute as never, `/products/${id}/promote`, { method: "POST", body: {}, params: { id } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ masterProductId: id, adopted: false, created: { product: true, brand: true } });
    const detail = await call(getProductRoute as never, `/products/${id}`, { params: { id } });
    expect(detail.body.catalogue).toMatchObject({ catalogueProductId: r.body.catalogueProductId });

    expect((await call(promoteRoute as never, `/products/${id}/promote`, { method: "POST", body: {}, params: { id } })).status).toBe(409);
    const other = await idOf("Thing With No Category");
    const bad = await call(promoteRoute as never, `/products/${other}/promote`, { method: "POST", body: {}, params: { id: other } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reasons.length).toBeGreaterThan(0);
  });
});
