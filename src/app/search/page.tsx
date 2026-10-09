import Link from "next/link";

import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { EmptyState, PageHeader } from "@/components/ui";
import { ShopGrid } from "@/components/shop-grid";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { serviceableShopIds } from "@/server/services/serviceability";
import { getCartLineQuantities } from "@/server/services/cart";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { searchShops } from "@/server/services/shops";

export const metadata = { title: "Search" };
export const dynamic = "force-dynamic";

/**
 * Unified search across products, shops, area and PIN code (§6). With a
 * delivery location chosen, results are limited to shops that deliver there
 * and sorted nearest first (GS-019/020); `?all=1` shows every shop.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; all?: string; view?: string; page?: string }>;
}) {
  const { q, all, view, page: pageParam } = await searchParams;
  const query = (q ?? "").trim();
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  const nearOnly = Boolean(location) && all !== "1";

  if (!query) {
    return (
      <>
        <PageHeader title="Search" />
        <EmptyState
          title="What are you looking for?"
          description="Search for a product, a shop, an area or a PIN code."
        />
      </>
    );
  }

  const distances = location ? await serviceableShopIds(location) : undefined;
  const shopIds = nearOnly && distances ? [...distances.keys()] : undefined;
  const [products, foundShops, cartLines] = await Promise.all([
    listStorefrontProducts({ query, shopIds, limit: 40 }),
    searchShops({ query, ids: shopIds, limit: 12 }),
    user ? getCartLineQuantities(user.id) : null,
  ]);
  const byDistance = (a: string, b: string) =>
    (distances?.get(a) ?? Number.POSITIVE_INFINITY) - (distances?.get(b) ?? Number.POSITIVE_INFINITY);
  const shops = foundShops
    .map((shop) => ({ ...shop, distanceKm: distances?.get(shop.id) ?? null }))
    .sort((a, b) => byDistance(a.id, b.id));
  if (nearOnly) products.sort((a, b) => byDistance(a.shopId, b.shopId));
  const tab = view === "shops" && shops.length > 0 ? "shops" : products.length > 0 ? "products" : "shops";
  const productPage = paginate(products, tab === "products" ? pageParam : 1, 6);
  const shopPage = paginate(shops, tab === "shops" ? pageParam : 1, 6);
  const base = `/search?q=${encodeURIComponent(query)}${all === "1" ? "&all=1" : ""}`;
  const lang = await getBoardLang();

  return (
    <>
      <PageHeader
        title={`Results for "${query}"`}
        description={`${products.length} product${products.length === 1 ? "" : "s"} · ${shops.length} shop${shops.length === 1 ? "" : "s"}`}
      />

      {location ? (
        <p className="mb-6 text-xs text-ink-500">
          {nearOnly ? "Showing only shops that deliver to you. " : "Showing all shops. "}
          <Link
            href={`/search?q=${encodeURIComponent(query)}${nearOnly ? "&all=1" : ""}`}
            className="font-medium text-kesari-600 hover:underline"
          >
            {nearOnly ? "Show all shops" : "Only shops that deliver to me"}
          </Link>
        </p>
      ) : null}

      {products.length > 0 || shops.length > 0 ? (
        <>
          {/* Products or shops, six at a time: the results used to run to several phone screens. */}
          <h2 className="sr-only">{tab === "products" ? "Products" : "Shops"}</h2>
          <ListTabs
            label="Results"
            active={tab}
            tabs={[
              ...(products.length > 0 ? [{ key: "products", label: "Products", href: `${base}&view=products`, count: products.length }] : []),
              ...(shops.length > 0 ? [{ key: "shops", label: "Shops", href: `${base}&view=shops`, count: shops.length }] : []),
            ]}
          />
          {tab === "products" ? (
            <ProductGrid products={productPage.rows} signedIn={Boolean(user)} cartLines={cartLines} distances={distances} />
          ) : (
            <ShopGrid shops={shopPage.rows} />
          )}
          <Pager
            lang={lang}
            page={tab === "products" ? productPage.page : shopPage.page}
            pageCount={tab === "products" ? productPage.pageCount : shopPage.pageCount}
            hrefFor={(n) => `${base}&view=${tab}&page=${n}`}
          />
        </>
      ) : null}

      {products.length === 0 && shops.length === 0 ? (
        <EmptyState
          title="Nothing found"
          description="Try a different product, shop name, area or PIN code."
        />
      ) : null}
    </>
  );
}
