import Link from "next/link";
import { after } from "next/server";

import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { EmptyIllustration } from "@/components/empty-illustrations";
import { SearchBox } from "@/components/home/search-box";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { ShopGrid } from "@/components/shop-grid";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerLocation } from "@/server/location";
import { serviceableShopIds } from "@/server/services/serviceability";
import { getCartLineQuantities } from "@/server/services/cart";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { searchShops } from "@/server/services/shops";
import { nearbyOfferCounts } from "@/server/services/home-discovery";
import { recordSearch } from "@/server/services/search-suggest";
import { tr } from "@/lib/board/i18n";
import { HOME } from "@/lib/home-i18n";

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

  const lang = await getBoardLang();
  if (!query) {
    return (
      <>
        <PageHeader title={tr(HOME.submitSearch, lang)} />
        {/* docs/homepage-uiux-2026-10 (F2): the phone header's search icon lands here — the search with suggestions, recent and trending. */}
        <SearchBox lang={lang} signedIn={Boolean(user)} size="lg" autoFocus className="mb-4" />
        <EmptyState
          illustration={<EmptyIllustration name="search" />}
          title={tr(HOME.searchStartTitle, lang)}
          description={tr(HOME.searchStartText, lang)}
          testId="search-start"
        />
      </>
    );
  }

  // Recent searches and trending (signed-in customers' only; a guest's search is not kept): the first page of a search only.
  if (!pageParam && !view) after(() => recordSearch(user?.id ?? null, query));

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
  // "Compare N prices" on cards sold by two or more shops near the customer (F4).
  const compareCounts = distances ? await nearbyOfferCounts(productPage.rows.map((p) => p.productId), [...distances.keys()]) : undefined;

  return (
    <>
      <PageHeader
        title={`Results for "${query}"`}
        description={`${products.length} product${products.length === 1 ? "" : "s"} · ${shops.length} shop${shops.length === 1 ? "" : "s"}`}
      />

      {location ? (
        <p className="mb-6 text-xs text-ink-500">
          {nearOnly ? "Showing only shops that deliver to you. " : "Showing all shops. "}
          <Link prefetch={false}
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
            <ProductGrid products={productPage.rows} signedIn={Boolean(user)} cartLines={cartLines} distances={distances} compareCounts={compareCounts} />
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
          illustration={<EmptyIllustration name="search" />}
          title={`${tr(HOME.searchEmptyTitle, lang)} “${query}”`}
          description={tr(HOME.searchEmptyText, lang)}
          action={<LinkButton href="/categories">{tr(HOME.browseCategories, lang)}</LinkButton>}
          secondaryAction={
            <LinkButton href="/shops" variant="secondary">
              {tr(HOME.seeShopsNearYou, lang)}
            </LinkButton>
          }
          testId="search-no-results"
        />
      ) : null}
    </>
  );
}
