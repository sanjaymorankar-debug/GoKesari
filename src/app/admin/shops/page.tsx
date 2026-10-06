import { redirect } from "next/navigation";

import { ShopProductManagementList } from "@/components/shop-product-management-list";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { countProductsByShop } from "@/server/services/catalogue";
import { searchShopsAdmin } from "@/server/services/shops";

export const metadata = { title: "Shop Product Management" };
export const dynamic = "force-dynamic";

/**
 * Admin "Shop Product Management" — select a shop, then manage its catalogue.
 *
 * This is the entry point the product-management brief asks for: admin needs
 * to reach ANY shop's products, not just their own. The per-shop authorization
 * this links into already existed (`requireShopAccess` + the `_ANY`
 * permissions) — what was missing was purely this page.
 */
export default async function AdminShopsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY)) redirect("/");

  const shops = await searchShopsAdmin({ limit: 500 });
  const counts = await countProductsByShop(shops.map((s) => s.id));

  return (
    <>
      <PageHeader
        title="Shop Product Management"
        description="Select a shop to add products, upload a product or price list, or review its catalogue."
      />
      <ShopProductManagementList
        canSuspend={can(user.role, PERMISSIONS.SHOP_SUSPEND)}
        shops={shops.map((s) => ({
          id: s.id,
          registrationNumber: s.registrationNumber,
          name: s.name,
          ownerName: s.ownerName,
          shopType: s.shopType,
          classification: s.classification,
          status: s.status,
          stage: s.status === "PENDING_APPROVAL" ? s.lifecycleStatus : null,
          productCount: counts[s.id] ?? 0,
        }))}
      />
    </>
  );
}
