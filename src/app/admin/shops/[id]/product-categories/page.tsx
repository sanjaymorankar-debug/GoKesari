import { notFound, redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";

import { ShopProductCategoriesView } from "@/components/shop-product-categories-view";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";

export const metadata = { title: "Shop product categories" };
export const dynamic = "force-dynamic";

/** Operations manages the product categories of any shop. */
export default async function AdminShopProductCategoriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; category?: string; offset?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_PRODUCT_CATEGORY_MANAGE_ANY)) redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, id), isNull(shops.deletedAt)));
  if (!shop) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={`Product categories — ${shop.name}`}
        description={`${shop.ownerName} · ${shop.city}. The shop sees every product in these categories. Removing one pauses its listings in it; orders are not affected.`}
        action={
          <LinkButton href={`/admin/shops/${shop.id}/products`} variant="secondary">
            Shop products
          </LinkButton>
        }
      />
      <ShopProductCategoriesView
        shopId={shop.id}
        viewer={user}
        basePath={`/admin/shops/${shop.id}/product-categories`}
        params={await searchParams}
      />
    </div>
  );
}
