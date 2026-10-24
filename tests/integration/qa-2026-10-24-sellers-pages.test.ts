/**
 * The shop page (/shops/[slug]) from the QA run of 24 Oct 2026: the real server
 * component runs against the real database and its output is rendered to HTML.
 *
 * TC-CAT-050 — a shop with more than 100 products shows every category, and a
 *   later category's products on ?cat=…, paged from the database.
 * TC-FLD-055 — the shop description keeps its line breaks (text still escaped).
 * TC-CAT-008 — a card shows the MRP struck through and "x% off".
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children }: { href: string; children?: React.ReactNode }) => React.createElement("a", { href }, children) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/server/auth", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));
vi.mock("@/server/authz/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/authz/guards")>()),
  getCurrentUser: async () => null,
}));

import ShopPage from "@/app/shops/[slug]/page";
import { db } from "@/server/db";
import { productCategories, products, shopProducts, shops } from "@/server/db/schema";
import { createCategory, createShop, createUser, linkShopCategory, resetDatabase } from "../helpers/fixtures";

const render = async (slug: string, query: { cat?: string; page?: string } = {}) =>
  renderToStaticMarkup(await ShopPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) }));

beforeEach(resetDatabase);

async function bigShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Big Shop C" });
  const big = await createCategory({ name: "Bulk Goods" });
  const late = await createCategory({ name: "Late Category" });
  await db.update(productCategories).set({ sortOrder: 0 }).where(eq(productCategories.id, big.id));
  await db.update(productCategories).set({ sortOrder: 99 }).where(eq(productCategories.id, late.id));
  const rows = await db
    .insert(products)
    .values([
      ...Array.from({ length: 110 }, (_, i) => ({ categoryId: big.id, name: `Bulk ${String(i).padStart(3, "0")}`, slug: `bulk-${i}-${Date.now()}`, unit: "kg" })),
      { categoryId: late.id, name: "Late Only Product", slug: `late-${Date.now()}`, unit: "piece", mrpPaise: 6000 },
    ])
    .returning({ id: products.id, categoryId: products.categoryId });
  await linkShopCategory(shop.id, big.id);
  await linkShopCategory(shop.id, late.id);
  await db.insert(shopProducts).values(
    rows.map((p) => ({ shopId: shop.id, productId: p.id, onlineSaleEnabled: true, onlinePricePaise: p.categoryId === late.id ? 5800 : 1000, onlineStock: 5 })),
  );
  return shop;
}

describe("TC-CAT-050: every category of a big shop is reachable", () => {
  it("lists the later category as a tab and shows its products on ?cat=", async () => {
    const shop = await bigShop();
    const first = await render(shop.slug);
    expect(first).toContain("Late Category");
    expect(first).toContain("Bulk 000");
    expect(first).not.toContain("Late Only Product");

    const late = await render(shop.slug, { cat: "Late Category" });
    expect(late).toContain("Late Only Product");
    expect(late).not.toContain("Bulk 000");

    // The big category pages on through all 110: page 19 holds the last five.
    const lastPage = await render(shop.slug, { cat: "Bulk Goods", page: "19" });
    expect(lastPage).toContain("Bulk 109");
    expect(lastPage).not.toContain("Bulk 000");
  });

  it("TC-CAT-008: a card shows the MRP struck through and the discount", async () => {
    const shop = await bigShop();
    const html = await render(shop.slug, { cat: "Late Category" });
    expect(html).toMatch(/data-testid="product-mrp">MRP <span class="line-through">(<[^>]+>)*₹60</);
    expect(html).toContain("3% off");
  });
});

describe("TC-FLD-055: the shop description keeps its line breaks", () => {
  it("renders with whitespace-pre-line and escapes markup", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Lines Dairy" });
    await db.update(shops).set({ description: "Fresh milk daily\nOpen on Sundays\n<b>bold</b>" }).where(eq(shops.id, shop.id));
    const html = await render(shop.slug);
    expect(html).toMatch(/class="[^"]*whitespace-pre-line[^"]*">Fresh milk daily\nOpen on Sundays\n&lt;b&gt;bold&lt;\/b&gt;/);
  });
});
