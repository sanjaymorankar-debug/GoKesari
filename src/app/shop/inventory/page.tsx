import { redirect } from "next/navigation";

import { SubmenuStrip } from "@/components/board/submenu-strip";
import { ShopInventoryManager } from "@/components/shop-inventory-manager";
import { PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getInventoryDashboard, listInventory, listStockAlerts } from "@/server/services/inventory-alerts";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Inventory" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Inventory", "इन्वेंटरी", "इन्व्हेंटरी"),
  description: L("{shop} — stock levels, thresholds and alerts.", "{shop} — स्टॉक, सीमा और अलर्ट।", "{shop} — स्टॉक, मर्यादा आणि सूचना."),
} as const;

export default async function ShopInventoryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);

  const [dashboard, rows, alerts, lang] = await Promise.all([
    getInventoryDashboard(shop.id),
    listInventory(shop.id),
    listStockAlerts(shop.id),
    getBoardLang(),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={tr(T.title, lang)} description={tr(T.description, lang).replace("{shop}", shop.name)} />
      <SubmenuStrip board="shop" menuKey="inventory" role={user.role} lang={lang} current="stock" counts={{ shopLowStock: alerts.length }} />
      <ShopInventoryManager
        shopId={shop.id}
        lang={lang}
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
