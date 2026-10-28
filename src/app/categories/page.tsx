import { CategoryFinder } from "@/components/category-finder";
import { PageHeader } from "@/components/ui";
import { listShopTypes } from "@/server/services/shop-types";

export const metadata = { title: "Categories" };

/** Directory of all supported shop types (requirement §6, §7). */
export default async function CategoriesPage() {
  const shopTypes = await listShopTypes();
  return (
    <>
      <PageHeader title="Shop categories" description={`${shopTypes.length} shop types you can find and shop from.`} />
      <CategoryFinder types={shopTypes.map((t) => ({ key: t.key, label: t.label, goods: [...t.standardGoods] }))} />
    </>
  );
}
