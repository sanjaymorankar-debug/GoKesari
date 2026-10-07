import Link from "next/link";
import { redirect } from "next/navigation";

import { ShopProductCategoriesView } from "@/components/shop-product-categories-view";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "My product categories" };
export const dynamic = "force-dynamic";

/** A shop owner manages the categories of their own shop(s) — never anyone else's. */
export default async function OwnerShopCategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; q?: string; category?: string; offset?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const params = await searchParams;
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="My product categories" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  // Only the owner's own shops can be selected; anything else falls back to the first.
  const shop = shops.find((s) => s.id === params.shop) ?? shops[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={`Product categories — ${shop.name}`}
        description="Add a category to see all of its products (including ones added later) when adding products to your shop. Removing one pauses your listings in it; nothing is deleted."
        action={
          <Link href="/product-categories" className="text-sm font-medium text-kesari-600 hover:underline">
            All categories →
          </Link>
        }
      />
      {shops.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Your shops">
          {shops.map((s) => (
            <Link
              key={s.id}
              href={`/shop/product-categories?shop=${s.id}`}
              className={s.id === shop.id ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <ShopProductCategoriesView
        shopId={shop.id}
        viewer={user}
        basePath="/shop/product-categories"
        hidden={shops.length > 1 ? { shop: shop.id } : {}}
        params={params}
      />
    </div>
  );
}
