import { redirect } from "next/navigation";

import { ShopCategoriesAdmin } from "@/components/shop-categories-admin";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopCategories, listUncategorisedShops } from "@/server/services/shop-categories";

export const metadata = { title: "Shop categories" };
export const dynamic = "force-dynamic";

export default async function ShopCategoriesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "OPERATOR" && user.role !== "ADMIN") redirect("/");
  const [categories, uncategorised] = await Promise.all([listShopCategories(), listUncategorisedShops()]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Shop categories"
        description="What kind of business each shop runs. Owners choose several per shop; you manage the list and can assign categories to any shop. Customers do not browse by these."
      />
      <ShopCategoriesAdmin
        categories={categories.map((c) => ({ id: c.id, name: c.name, description: c.description, status: c.status, shopCount: c.shopCount }))}
        uncategorised={uncategorised}
      />
    </div>
  );
}
