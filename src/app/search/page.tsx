import Link from "next/link";

import { ProductGrid } from "@/app/page";
import { LocationBar } from "@/components/location-bar";
import { EmptyState, PageHeader, Section } from "@/components/ui";
import { ShopGrid } from "@/components/shop-grid";
import { getCurrentUser } from "@/server/authz/guards";
import { getCustomerLocation } from "@/server/location";
import { serviceableShopIds } from "@/server/services/serviceability";
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
  searchParams: Promise<{ q?: string; all?: string }>;
}) {
  const { q, all } = await searchParams;
  const query = (q ?? "").trim();
  const user = await getCurrentUser();
  const location = await getCustomerLocation(user?.id);
  const nearOnly = Boolean(location) && all !== "1";

  if (!query) {
    return (
      <>
        <PageHeader title="Search" />
        <LocationBar userId={user?.id ?? null} location={location} />
        <EmptyState
          title="What are you looking for?"
          description="Search for a product, a shop, an area or a PIN code."
        />
      </>
    );
  }

  const distances = location ? await serviceableShopIds(location) : undefined;
  const shopIds = nearOnly && distances ? [...distances.keys()] : undefined;
  const [products, foundShops] = await Promise.all([
    listStorefrontProducts({ query, shopIds, limit: 40 }),
    searchShops({ query, ids: shopIds, limit: 12 }),
  ]);
  const byDistance = (a: string, b: string) =>
    (distances?.get(a) ?? Number.POSITIVE_INFINITY) - (distances?.get(b) ?? Number.POSITIVE_INFINITY);
  const shops = foundShops
    .map((shop) => ({ ...shop, distanceKm: distances?.get(shop.id) ?? null }))
    .sort((a, b) => byDistance(a.id, b.id));
  if (nearOnly) products.sort((a, b) => byDistance(a.shopId, b.shopId));

  return (
    <>
      <PageHeader
        title={`Results for "${query}"`}
        description={`${products.length} product${products.length === 1 ? "" : "s"} · ${shops.length} shop${shops.length === 1 ? "" : "s"}`}
      />

      <LocationBar userId={user?.id ?? null} location={location} />
      {location ? (
        <p className="-mt-3 mb-6 text-xs text-ink-500">
          {nearOnly ? "Showing only shops that deliver to you. " : "Showing all shops. "}
          <Link
            href={`/search?q=${encodeURIComponent(query)}${nearOnly ? "&all=1" : ""}`}
            className="font-medium text-kesari-600 hover:underline"
          >
            {nearOnly ? "Show all shops" : "Only shops that deliver to me"}
          </Link>
        </p>
      ) : null}

      {shops.length > 0 ? (
        <Section title="Shops">
          <ShopGrid shops={shops} />
        </Section>
      ) : null}

      {products.length > 0 ? (
        <Section title="Products">
          <ProductGrid products={products} signedIn={Boolean(user)} distances={distances} />
        </Section>
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
