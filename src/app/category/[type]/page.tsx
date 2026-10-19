import { notFound } from "next/navigation";

import { Pager, paginate } from "@/components/board/list-tabs";
import { ProductGrid } from "@/components/product-grid";
import { EmptyState, PageHeader } from "@/components/ui";
import { SHOP_TYPES, type ShopTypeKey } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getCartLineQuantities } from "@/server/services/cart";
import { getBoardLang } from "@/server/board-lang";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { getCustomerLocation } from "@/server/location";
import { nearbyOfferCounts } from "@/server/services/home-discovery";
import { serviceableShopIds } from "@/server/services/serviceability";

export const dynamic = "force-dynamic";

function findShopType(type: string) {
  return SHOP_TYPES.find((t) => t.key === type);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  return { title: findShopType(type)?.label ?? "Category" };
}

const PAGE_SIZE = 6;

/** Generic product browsing for any of the 44 shop types (requirement §6, §7). */
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ type }, query, lang] = await Promise.all([params, searchParams, getBoardLang()]);
  const shopType = findShopType(type);
  if (!shopType) notFound();

  const user = await getCurrentUser();
  const [products, cartLines] = await Promise.all([
    listStorefrontProducts({
      department: type as ShopTypeKey,
      limit: 60,
    }),
    user ? getCartLineQuantities(user.id) : null,
  ]);

  const page = paginate(products, query.page, PAGE_SIZE);
  // docs/homepage-uiux-2026-10 (F4): "Compare N prices" on products two or more nearby shops sell.
  const location = await getCustomerLocation(user?.id).catch(() => null);
  const nearby = location ? await serviceableShopIds(location).catch(() => null) : null;
  const compareCounts = nearby ? await nearbyOfferCounts(page.rows.map((p) => p.productId), [...nearby.keys()]) : undefined;

  return (
    <>
      <PageHeader
        title={shopType.label}
        description={shopType.standardGoods.slice(0, 8).join(", ")}
      />
      {products.length === 0 ? (
        <EmptyState title={`No ${shopType.label.toLowerCase()} products listed yet.`} />
      ) : (
        <>
          {/* Six at a time (three rows on a phone): pages instead of one long list. */}
          <ProductGrid products={page.rows} signedIn={Boolean(user)} cartLines={cartLines} compareCounts={compareCounts} />
          <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/category/${type}?page=${n}`} />
        </>
      )}
    </>
  );
}
