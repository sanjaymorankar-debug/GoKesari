import { redirect } from "next/navigation";

import { SubmenuStrip } from "@/components/board/submenu-strip";
import { ShopInventoryManager } from "@/components/shop-inventory-manager";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getInventoryDashboard, listInventory, listStockAlerts } from "@/server/services/inventory-alerts";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Inventory" };
export const dynamic = "force-dynamic";

export default async function ShopInventoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [dashboard, rows, alerts, lang] = await Promise.all([
    getInventoryDashboard(shop.id),
    listInventory(shop.id),
    listStockAlerts(shop.id),
    getBoardLang(),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Inventory" description={`${shop.name} — stock levels, thresholds and alerts.`} />
      <SubmenuStrip board="shop" menuKey="inventory" role={user.role} lang={lang} current="stock" counts={{ shopLowStock: alerts.length }} />
      <ShopInventoryManager
        shopId={shop.id}
        view={{
          dashboard,
          rows,
          alerts: alerts.map((a) => ({ id: a.id, shopProductId: a.shopProductId, alertType: a.alertType, stockAtAlert: a.stockAtAlert })),
          shopDefaults: {
            lowStockThreshold: shop.defaultLowStockThreshold,
            reorderLevel: shop.defaultReorderLevel,
            reorderQuantity: shop.defaultReorderQuantity,
          },
        }}
      />
    </div>
  );
}
