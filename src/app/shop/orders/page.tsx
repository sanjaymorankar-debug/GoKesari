import { redirect } from "next/navigation";

import { ShopOrderManager } from "@/components/shop-order-manager";
import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getDeliveryOrdersForOrders, getRiderSearchStatus } from "@/server/services/delivery-assignment";
import { listShopProducts } from "@/server/services/catalogue";
import { listOrdersForShop } from "@/server/services/orders";
import { listShopsForOwner } from "@/server/services/shops";
import { proofPhotosForOrders } from "@/server/services/delivery-proofs";
import { getRule } from "@/server/services/settings";
import { getShopWalletStatus } from "@/server/services/shop-wallet";
import { getShopFulfilmentViews, listDeliveryStaff, plannerOptions } from "@/server/services/fulfilment-options";

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

  const [orders, onlineProducts, wallet] = await Promise.all([
    listOrdersForShop(shop.id, { limit: 100 }),
    listShopProducts(shop.id, { onlineOnly: true }),
    getShopWalletStatus(shop.id),
  ]);
  const deliveryOrders = await getDeliveryOrdersForOrders(orders.map((o) => o.id));
  // NEW-007: invoice and delivery-photo links on delivered orders.
  const delivered = orders.filter((o) => o.status === "DELIVERED").map((o) => o.id);
  const [proofPhotos, invoicingRule] = await Promise.all([proofPhotosForOrders(delivered), getRule("invoicing")]);
  // Only READY orders of a delivering shop are waiting for a rider.
  const searchByOrder = new Map(
    shop.deliveryAvailable
      ? await Promise.all(
          orders.filter((o) => o.status === "READY").map(async (o) => [o.id, await getRiderSearchStatus(o.id)] as const),
        )
      : [],
  );
  // Fulfilment options (docs/four-features-2026-10): plans, slots and the shop's own delivery people.
  const [plans, planner, deliveryStaff] = await Promise.all([
    getShopFulfilmentViews(orders.map((o) => o.id)),
    plannerOptions(),
    listDeliveryStaff(shop.id, { activeOnly: true }),
  ]);
  const fulfilment =
    planner.enabled || plans.size > 0
      ? { enabled: planner.enabled, days: planner.days, staff: deliveryStaff.map((s) => ({ id: s.id, name: s.name, phoneE164: s.phoneE164 })), refundDeliveryFeeOnPickup: planner.refundDeliveryFeeOnPickup }
      : null;
  // Candidates a shop can offer as a substitute (server re-checks price/stock).
  const substitutes = onlineProducts
    .filter((sp) => sp.onlinePricePaise != null)
    .map((sp) => ({ shopProductId: sp.id, label: `${sp.product.name} (${sp.product.unit})` }));

  return (
    <>
      <PageHeader title="Orders" description={`${shop.name} — manage and fulfil incoming orders.`} />
      {/* Shop wallet: below the minimum the shop cannot accept new orders (the server refuses too). */}
      <ShopWalletBanner {...wallet} />

      {orders.length === 0 ? (
        <EmptyState title="No orders yet." />
      ) : (
        <ShopOrderManager
          deliveryAvailable={shop.deliveryAvailable}
          substitutes={substitutes}
          fulfilment={fulfilment}
          orders={orders.map((o) => ({
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            totalPaise: o.totalPaise,
            createdAt: o.createdAt.toISOString(),
            orderType: o.orderType,
            paymentMethod: o.paymentMethod,
            cashCollected: o.codCollectedAt != null,
            acceptByAt: o.acceptByAt ? o.acceptByAt.toISOString() : null,
            invoiceUrl: o.status === "DELIVERED" && invoicingRule.enabled ? `/api/orders/${o.id}/invoice` : null,
            proofPhotoUrl: proofPhotos.get(o.id)?.url ?? null,
            scheduledSlot:
              o.scheduledSlotStart && o.scheduledSlotEnd
                ? { start: o.scheduledSlotStart.toISOString(), end: o.scheduledSlotEnd.toISOString() }
                : null,
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
            fulfilmentPlan: plans.get(o.id) ?? null,
            hasAddress: o.deliveryAddressSnapshot != null,
            deliveryFeePaise: o.deliveryFeePaise,
            deliveryStatus: deliveryOrders.get(o.id)?.status ?? null,
            pickupCode: deliveryOrders.get(o.id)?.pickupCode ?? null,
            riderSearch: searchByOrder.has(o.id)
              ? {
                  state: searchByOrder.get(o.id)!.state,
                  message: searchByOrder.get(o.id)!.message,
                  attempts: searchByOrder.get(o.id)!.attempts,
                  maxAttempts: searchByOrder.get(o.id)!.maxAttempts,
                  canRetry: searchByOrder.get(o.id)!.canRetry,
                }
              : null,
          }))}
        />
      )}
    </>
  );
}
