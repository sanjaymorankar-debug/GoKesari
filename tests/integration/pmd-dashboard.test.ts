/**
 * Product Master dashboard page: the real server component is executed against the real
 * database and its output rendered to HTML. (A full `next dev` render is not needed to
 * prove what the page shows, and would write a large build cache.)
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; role: string },
  failReport: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children }: { href: string; children?: React.ReactNode }) => React.createElement("a", { href }, children) };
});
vi.mock("@/server/authz/guards", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/server/pmd/services/reference", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/pmd/services/reference")>();
  return {
    ...real,
    getDataQualityReport: async (...a: Parameters<typeof real.getDataQualityReport>) => {
      if (state.failReport) throw new Error('relation "pmd.dashboard_metric" does not exist');
      return real.getDataQualityReport(...a);
    },
  };
});

import ProductMasterPage from "@/app/admin/product-master/page";
import { PmdReviewQueue, type PmdReviewRow } from "@/components/pmd-review-queue";
import { resetDatabase } from "../helpers/fixtures";
import { GTIN, ingest, product, resetPmd, seedReference } from "../helpers/pmd";

const html = async () => renderToStaticMarkup(await ProductMasterPage());
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeAll(async () => {
  await seedReference();
});
beforeEach(async () => {
  state.failReport = false;
  state.user = { id: "u1", email: "ops@test.local", role: "ADMIN" };
  await resetDatabase();
  await resetPmd();
});

describe("Product Master dashboard page", () => {
  it("sends anonymous visitors to sign in and keeps customers and shop owners out", async () => {
    state.user = null;
    await expect(html()).rejects.toThrow("REDIRECT:/signin");
    for (const role of ["CUSTOMER", "SHOP_OWNER"]) {
      state.user = { id: "u", email: "x@test.local", role };
      await expect(html()).rejects.toThrow("REDIRECT:/");
    }
  });

  it("shows every metric the brief asks for, with values that match the database", async () => {
    await ingest("test_market_a", [
      product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul", gtin: GTIN.MILK_1L, offer: { sellerName: "Alpha", price: 66, stock: "in stock", collectedAt: "2026-09-01" } }),
      product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul" }),
      product({ sourceProductId: "P3", name: "Mystery Thing" }),
    ]);
    const page = text(await html());
    for (const label of ["Total products", "Duplicates merged", "Possible duplicates", "Awaiting manual review", "Missing GTIN", "Missing brand", "Missing manufacturer",
      "Missing MRP", "Missing GST rate", "Missing HSN", "Missing category", "Conflicting specifications", "Products by marketplace", "Products by category", "Products by brand", "Recent collection runs"]) {
      expect(page, label).toContain(label);
    }
    // 3 products, 2 without a GTIN, 1 without a brand, all without a category
    expect(page).toMatch(/Total products\s+3/);
    expect(page).toMatch(/Missing GTIN\s+2/);
    expect(page).toMatch(/Missing brand\s+1/);
    expect(page).toMatch(/Missing category\s+3/);
    expect(page).toContain("test_market_a");
    expect(page).toContain("Amul");
  });

  it("lists possible duplicates for review, with decision buttons only for people who may decide", async () => {
    await ingest("test_market_a", [product({ sourceProductId: "P1", name: "Amul Taaza Toned Milk 1 L", brand: "Amul" })]);
    await ingest("test_market_b", [product({ sourceProductId: "P2", name: "Amul Taza Toned Milk 1 L", brand: "Amul" })]);
    const admin = text(await html());
    expect(admin).toContain("Amul Taza Toned Milk 1 L");
    expect(admin).toContain("Amul Taaza Toned Milk 1 L");
    expect(admin).toContain("Same product");
    expect(admin).toContain("Different");
    expect(admin).toContain("Same family");
  });

  it("explains itself when the schema has not been migrated instead of crashing", async () => {
    state.failReport = true;
    const page = text(await html());
    expect(page).toContain("not installed in this database");
    expect(page).toContain("db:migrate");
  });

  it("the review component renders an empty state and hides decisions from read-only viewers", () => {
    expect(text(renderToStaticMarkup(createElement(PmdReviewQueue, { rows: [], canDecide: true })))).toContain("No possible duplicates waiting");
    const row: PmdReviewRow = {
      candidateId: 7, matchScore: 82.5, matchStatus: "POSSIBLE_MATCH", relation: "SAME_PRODUCT", rule: "L4_FUZZY", hardConflicts: ["PACK_SIZE_DIFFERENT"],
      incoming: { source: "src", name: "Incoming Name", brand: "B" }, candidate: { masterProductId: "GKS-PROD-000000001", name: "Existing Name", brand: "B", packSize: "1000 ml" },
    };
    const readOnly = text(renderToStaticMarkup(createElement(PmdReviewQueue, { rows: [row], canDecide: false })));
    expect(readOnly).toContain("Incoming Name");
    expect(readOnly).toContain("PACK_SIZE_DIFFERENT");
    expect(readOnly).toContain("score 82.5");
    expect(readOnly).not.toContain("Same product");
    expect(text(renderToStaticMarkup(createElement(PmdReviewQueue, { rows: [row], canDecide: true })))).toContain("Same product");
  });
});
