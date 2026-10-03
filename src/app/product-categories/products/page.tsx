import Link from "next/link";
import { redirect } from "next/navigation";

import { ProductBrowser, PAGE_SIZE, readBrowseParams } from "@/components/product-browser";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { browseCatalogue, listSelectableCategories } from "@/server/services/product-categories";

export const metadata = { title: "Products by category" };
export const dynamic = "force-dynamic";

/** Product Master view: every product, searchable and filterable by category. */
export default async function ProductsByCategoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; offset?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.CATALOGUE_BROWSE)) redirect("/");
  const { query, categoryId, offset } = readBrowseParams(await searchParams);
  const [categories, { products, total }] = await Promise.all([
    listSelectableCategories(),
    browseCatalogue({ query, categoryId: categoryId || undefined, offset, limit: PAGE_SIZE }),
  ]);
  const current = categories.find((c) => c.id === categoryId);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={current ? `Products — ${current.name}` : "Products by category"}
        description="The published catalogue. Filter by category or search by name, product ID or brand."
        action={
          <Link href="/product-categories" className="text-sm font-medium text-kesari-600 hover:underline">
            ← Product categories
          </Link>
        }
      />
      <ProductBrowser
        basePath="/product-categories/products"
        products={products}
        total={total}
        categories={categories}
        query={query}
        categoryId={categoryId}
        offset={offset}
        movable={can(user.role, PERMISSIONS.PRODUCT_MANAGE)}
      />
    </div>
  );
}
