import { CategoryFinder } from "@/components/category-finder";
import { PageHeader } from "@/components/ui";
import { SHOP_TYPES } from "@/lib/shop-types";

export const metadata = { title: "Categories" };

/** Directory of all supported shop types (requirement §6, §7). */
export default function CategoriesPage() {
  return (
    <>
      <PageHeader title="Shop categories" description={`${SHOP_TYPES.length} shop types you can find and shop from.`} />
      <CategoryFinder types={SHOP_TYPES.map((t) => ({ key: t.key, label: t.label, goods: [...t.standardGoods] }))} />
    </>
  );
}
