/**
 * One shop's categories and the products it sees through them. Shared by the
 * owner's page and the operations page; both callers have already checked
 * that the viewer may manage this shop.
 */
import { ProductBrowser, PAGE_SIZE, readBrowseParams } from "@/components/product-browser";
import { ShopProductCategoriesManager } from "@/components/shop-product-categories-manager";
import { Section } from "@/components/ui";
import {
  listProductsVisibleToShop,
  listSelectableCategories,
  listShopProductCategories,
} from "@/server/services/product-categories";

export async function ShopProductCategoriesView({
  shopId,
  basePath,
  hidden = {},
  params,
}: {
  shopId: string;
  basePath: string;
  hidden?: Record<string, string>;
  params: { q?: string; category?: string; offset?: string };
}) {
  const { query, categoryId, offset } = readBrowseParams(params);
  const [assigned, selectable] = await Promise.all([listShopProductCategories(shopId), listSelectableCategories()]);
  const carried = assigned.map((a) => ({ id: a.categoryId, name: a.name }));
  // Filtering by a category the shop does not carry would show nothing; ignore it.
  const filter = carried.some((c) => c.id === categoryId) ? categoryId : "";
  const { products, total } = await listProductsVisibleToShop(shopId, {
    query,
    categoryId: filter || undefined,
    offset,
    limit: PAGE_SIZE,
  });

  return (
    <div className="space-y-8">
      <Section title={`Categories this shop carries (${assigned.length})`}>
        <ShopProductCategoriesManager
          shopId={shopId}
          assigned={assigned.map((a) => ({ ...a, addedAt: a.addedAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) }))}
          selectable={selectable}
        />
      </Section>
      <Section title="Products visible to this shop">
        <ProductBrowser
          basePath={basePath}
          hidden={hidden}
          products={products}
          total={total}
          categories={carried}
          query={query}
          categoryId={filter}
          offset={offset}
        />
      </Section>
    </div>
  );
}
