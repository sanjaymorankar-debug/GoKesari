import { notFound } from "next/navigation";

import { ProductGrid } from "@/components/product-grid";
import { EmptyState, PageHeader } from "@/components/ui";
import { SHOP_TYPES, type ShopTypeKey } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { listStorefrontProducts } from "@/server/services/catalogue";

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

/** Generic product browsing for any of the 44 shop types (requirement §6, §7). */
export default async function CategoryPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  const shopType = findShopType(type);
  if (!shopType) notFound();

  const user = await getCurrentUser();
  const products = await listStorefrontProducts({
    department: type as ShopTypeKey,
    limit: 60,
  });

  return (
    <>
      <PageHeader
        title={shopType.label}
        description={shopType.standardGoods.slice(0, 8).join(", ")}
      />
      {products.length === 0 ? (
        <EmptyState title={`No ${shopType.label.toLowerCase()} products listed yet.`} />
      ) : (
        <ProductGrid products={products} signedIn={Boolean(user)} />
      )}
    </>
  );
}
