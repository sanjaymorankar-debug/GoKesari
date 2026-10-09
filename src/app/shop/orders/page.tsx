import { redirect } from "next/navigation";

import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { ShopOrderManager } from "@/components/shop-order-manager";
import { ShopWalletBanner } from "@/components/shop-wallet-banner";
import { EmptyState, PageHeader } from "@/components/ui";
import { tr, UI } from "@/lib/board/i18n";
import { SHOP_MENUS } from "@/lib/board/menus";
import { pickTab, SHOP_ORDER_TABS, type ShopOrderTab } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
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
const PAGE_SIZE = 5;
const TAB_KEYS = ["new", "packing", "ready", "out", "done", "all"] as const satisfies readonly ShopOrderTab[];

export default async function ShopOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [allOrders, onlineProducts, wallet, lang, query] = await Promise.all([
    listOrdersForShop(shop.id, { limit: 100 }),
    listShopProducts(shop.id, { onlineOnly: true }),
    getShopWalletStatus(shop.id),
    getBoardLang(),
    searchParams,
  ]);

  // Tabs = the board's Orders submenus (same status groups as its badges), plus Done and All.
  const inGroup = (tab: ShopOrderTab, status: string) =>
    tab === "all"
      ? true
      : tab === "done"
        ? !Object.values(SHOP_ORDER_TABS).some((g) => (g as readonly string[]).includes(status))
        : (SHOP_ORDER_TABS[tab] as readonly string[]).includes(status);
  const countOf = (tab: ShopOrderTab) => allOrders.filter((o) => inGroup(tab, o.status)).length;
  // No tab chosen: the first one with work waiting, else everything.
  const firstBusy = (["new", "packing", "ready", "out"] as const).find((t) => countOf(t) > 0) ?? "all";
  const tab = pickTab<ShopOrderTab>(query.status, TAB_KEYS, firstBusy);
  const page = paginate(allOrders.filter((o) => inGroup(tab, o.status)), query.page, PAGE_SIZE);
  const orders = page.rows;
  const menuLabels = Object.fromEntries((SHOP_MENUS.find((m) => m.key === "orders")?.items ?? []).map((i) => [i.key, tr(i.label, lang)]));
  const tabs = TAB_KEYS.map((key) => ({
    key,
    label: key === "done" ? tr(UI.done, lang) : key === "all" ? tr(UI.all, lang) : (menuLabels[key] ?? key),
    href: `/shop/orders?status=${key}`,
    count: key === "all" || key === "done" ? undefined : countOf(key),
    urgent: key === "new",
  }));
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

      <ListTabs tabs={tabs} active={tab} label={tr(UI.orders, lang)} />

      {orders.length === 0 ? (
        <EmptyState
          title={allOrders.length === 0 ? "No orders yet." : "Nothing here right now."}
          description={allOrders.length === 0 ? "New orders appear here and on your board the moment a customer places them." : "Orders move to the next tab as you work on them."}
        />
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
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/shop/orders?status=${tab}&page=${n}`} />
    </>
  );
}
