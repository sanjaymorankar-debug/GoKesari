import { redirect } from "next/navigation";

import { ShopOrderManager } from "@/components/shop-order-manager";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getDeliveryOrdersForOrders } from "@/server/services/delivery-assignment";
import { listShopProducts } from "@/server/services/catalogue";
import { listOrdersForShop } from "@/server/services/orders";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop Orders" };
export const dynamic = "force-dynamic";

/**
 * Shop owner's order queue — advance status and, once ready, find a
 * delivery partner (delivery-system Part 58, Slice C).
 */
export default async function ShopOrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [orders, onlineProducts] = await Promise.all([
    listOrdersForShop(shop.id, { limit: 100 }),
    listShopProducts(shop.id, { onlineOnly: true }),
  ]);
  const deliveryOrders = await getDeliveryOrdersForOrders(orders.map((o) => o.id));
  // Candidates a shop can offer as a substitute (server re-checks price/stock).
  const substitutes = onlineProducts
    .filter((sp) => sp.onlinePricePaise != null)
    .map((sp) => ({ shopProductId: sp.id, label: `${sp.product.name} (${sp.product.unit})` }));

  return (
    <>
      <PageHeader title="Orders" description={`${shop.name} — manage and fulfil incoming orders.`} />

      {orders.length === 0 ? (
        <EmptyState title="No orders yet." />
      ) : (
        <ShopOrderManager
          deliveryAvailable={shop.deliveryAvailable}
          substitutes={substitutes}
          orders={orders.map((o) => ({
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            totalPaise: o.totalPaise,
            createdAt: o.createdAt.toISOString(),
            orderType: o.orderType,
            // Explicit fields only — never pass the customer's delivery OTP to the shop.
            items: o.items.map((i) => ({
              id: i.id,
              productNameSnapshot: i.productNameSnapshot,
              unitSnapshot: i.unitSnapshot,
              quantityMilli: i.quantityMilli,
              lineTotalPaise: i.lineTotalPaise,
              fulfilmentStatus: i.fulfilmentStatus,
              substituteNameSnapshot: i.substituteNameSnapshot,
              substituteUnitSnapshot: i.substituteUnitSnapshot,
              substituteQuantityMilli: i.substituteQuantityMilli,
              substituteLineTotalPaise: i.substituteLineTotalPaise,
            })),
            deliveryStatus: deliveryOrders.get(o.id)?.status ?? null,
            pickupCode: deliveryOrders.get(o.id)?.pickupCode ?? null,
          }))}
        />
      )}
    </>
  );
}
