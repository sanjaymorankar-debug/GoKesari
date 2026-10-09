import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Money,
  PageHeader,
  StatusBadge,
} from "@/components/ui";
import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { CancelOrderButton } from "@/components/cancel-order-button";
import { TrackDeliveryButton } from "@/components/live-tracking-map";
import { RateOrderForm, ReportIssueForm } from "@/components/rating-actions";
import { SubstitutionDecision } from "@/components/substitution-decision";
import { formatQuantity } from "@/lib/money";
import { DISPUTE_STATUS_LABELS } from "@/lib/dispute-states";
import { isTrackableOrderStatus } from "@/lib/tracking";
import { tr, UI } from "@/lib/board/i18n";
import { CUSTOMER_MENUS } from "@/lib/board/menus";
import { IN_PROGRESS_ORDER_STATUSES, pickTab } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getDeliveryOrdersForOrders } from "@/server/services/delivery-assignment";
import { buyerDeliveryCodeView, type BuyerDeliveryCodeView } from "@/server/services/delivery-otp";
import { DeliveryCodePanel } from "@/components/delivery-code-panel";
import { maskEmailAddress } from "@/lib/contact";
import { getLiveDisputesForOrders } from "@/server/services/disputes";
import { referencesForGroups } from "@/server/services/order-groups";
import { listOrdersForUser } from "@/server/services/orders";
import { listMyRatingsByOrder } from "@/server/services/ratings";
import { formatScheduledSlot } from "@/lib/scheduled-slots";
import { proofPhotosForOrders } from "@/server/services/delivery-proofs";
import { getRule } from "@/server/services/settings";
import { getBuyerFulfilmentViews } from "@/server/services/fulfilment-options";
import { OrderFulfilmentCard } from "@/components/order-fulfilment-card";

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  OFFERED: "Finding a rider",
  ACCEPTED: "Rider assigned",
  PICKED_UP: "Picked up — on the way",
  DELIVERED: "Delivered",
  FAILED: "Delivery attempt failed",
  REJECTED: "Finding a rider",
  CANCELLED: "Finding a rider",
};

export const metadata = { title: "My Orders" };
export const dynamic = "force-dynamic";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ placed?: string; type?: string; tab?: string; page?: string; cancelled?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const params = await searchParams;
  // Personal and business (B2B) orders are separate flows, listed apart.
  const showBusiness = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const orderType = showBusiness && params.type === "business" ? "B2B" : "PERSONAL";
  const [allOrders, lang] = await Promise.all([listOrdersForUser(user.id, { limit: 50, orderType }), getBoardLang()]);
  // Tabs = the board's Orders submenus: Active (on its way) and Past, same statuses as the badges.
  const active = allOrders.filter((o) => IN_PROGRESS_ORDER_STATUSES.includes(o.status));
  const past = allOrders.filter((o) => !IN_PROGRESS_ORDER_STATUSES.includes(o.status));
  const tab = pickTab(params.tab, ["active", "past"] as const, active.length > 0 || past.length === 0 ? "active" : "past");
  const page = paginate(tab === "active" ? active : past, params.page, 5);
  const orders = page.rows;
  const typeParam = orderType === "B2B" ? "&type=business" : "";
  const tabLabels = Object.fromEntries((CUSTOMER_MENUS.find((m) => m.key === "orders")?.items ?? []).map((i) => [i.key, tr(i.label, lang)]));
  const [groupRefs, deliveryOrders, myRatings, liveDisputes] = await Promise.all([
    referencesForGroups(orders.map((o) => o.orderGroupId)),
    getDeliveryOrdersForOrders(orders.map((o) => o.id)),
    listMyRatingsByOrder(user.id, orders.map((o) => o.id)),
    getLiveDisputesForOrders(orders.map((o) => o.id)),
  ]);
  // The delivery code (stored hashed): emailed / locked / new-code state for drops under way.
  const deliveryCodes = new Map(
    (
      await Promise.all(
        orders
          .filter((o) => o.status === "OUT_FOR_DELIVERY" && deliveryOrders.has(o.id))
          .map(async (o) => [o.id, await buyerDeliveryCodeView(deliveryOrders.get(o.id)!)] as const),
      )
    ).filter((entry): entry is readonly [string, BuyerDeliveryCodeView] => entry[1] != null && (entry[1].active || entry[1].locked)),
  );
  // Fulfilment options (docs/four-features-2026-10): pickup / own delivery / GoKesari plan and time.
  const fulfilmentPlans = await getBuyerFulfilmentViews(orders.map((o) => o.id), user);
  // NEW-007: delivery photo and invoice links on delivered orders.
  const [proofPhotos, invoicingRule, cancellationRule] = await Promise.all([
    proofPhotosForOrders(orders.filter((o) => o.status === "DELIVERED").map((o) => o.id)),
    getRule("invoicing"),
    getRule("cancellation"),
  ]);
  // Before packing the customer may cancel (rule `cancellation`); the server checks again.
  const cancellable: readonly string[] = cancellationRule.customerMayCancelUntil === "PREPARING" ? ["CONFIRMED", "ACCEPTED", "PREPARING"] : ["CONFIRMED"];

  return (
    <>
      <PageHeader
        title="My Orders"
        description="Track everything you've ordered."
      />

      {showBusiness ? (
        <nav className="mb-6 flex gap-2" aria-label="Order type">
          <LinkButton
            href="/orders"
            variant={orderType === "PERSONAL" ? "primary" : "secondary"}
          >
            Personal orders
          </LinkButton>
          <LinkButton
            href="/orders?type=business"
            variant={orderType === "B2B" ? "primary" : "secondary"}
          >
            Business orders
          </LinkButton>
        </nav>
      ) : null}

      {params.cancelled ? (
        <div className="mb-6" data-testid="order-cancelled">
          <Alert tone="success" title={`Order ${params.cancelled} cancelled`}>
            The full amount has gone back to your wallet.{" "}
            <Link href="/wallet#history" className="font-medium underline">
              See wallet
            </Link>
          </Alert>
        </div>
      ) : null}

      {params.placed ? (
        <div className="mb-6">
          <Alert tone="success" title="Order placed">
            Your order has been confirmed and paid from your wallet.
          </Alert>
        </div>
      ) : null}

      <ListTabs
        label={tr(UI.orders, lang)}
        active={tab}
        tabs={[
          { key: "active", label: tabLabels.active ?? "Active", href: `/orders?tab=active${typeParam}`, count: active.length, urgent: true },
          { key: "past", label: tabLabels.past ?? "Past", href: `/orders?tab=past${typeParam}`, count: past.length },
          { key: "returns", label: tabLabels.returns ?? "Returns", href: "/returns" },
        ]}
      />

      {orders.length === 0 && allOrders.length > 0 ? (
        <EmptyState
          title={tab === "active" ? "No order on the way right now" : "No past orders yet"}
          description={tab === "active" ? "Orders you place appear here until they are delivered." : "Delivered and cancelled orders appear here."}
          action={<LinkButton href={tab === "active" ? "/orders?tab=past" : "/"}>{tab === "active" ? "See past orders" : "Start shopping"}</LinkButton>}
        />
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Your orders and subscription deliveries will appear here."
          action={<LinkButton href="/">Start shopping</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} id={`order-${order.orderNumber}`} className="p-5" data-testid="order-card">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={order.status} />
                  {order.source === "SUBSCRIPTION" ? (
                    <Badge tone="info">subscription</Badge>
                  ) : null}
                  {order.orderType === "B2B" ? <Badge tone="info">business</Badge> : null}
                  {order.paymentMethod === "COD" ? (
                    <Badge tone="warning">{order.codCollectedAt ? "paid in cash" : "pay cash on delivery"}</Badge>
                  ) : null}
                  <span className="text-sm text-ink-500">
                    {order.orderNumber}
                  </span>
                  {order.discountPaise > 0 ? (
                    <Badge tone="success">
                      {order.couponCode ? `${order.couponCode} · ` : ""}saved <Money paise={order.discountPaise} />
                    </Badge>
                  ) : null}
                  {order.orderGroupId && groupRefs.get(order.orderGroupId) ? (
                    <Link
                      href={`/orders/group/${groupRefs.get(order.orderGroupId)}`}
                      className="text-xs text-kesari-700 hover:underline"
                      data-testid="parent-order-ref"
                    >
                      Part of {groupRefs.get(order.orderGroupId)}
                    </Link>
                  ) : null}
                </div>
                <span className="font-semibold text-ink-900">
                  <Money paise={order.totalPaise} />
                </span>
              </div>

              <p className="text-sm font-medium text-ink-900">{order.shopName}</p>
              <p className="text-xs text-ink-500">
                {new Date(order.createdAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {order.deliveryDate && !order.scheduledSlotStart ? ` · for ${order.deliveryDate}` : ""}
              </p>
              {order.status === "DELIVERED" && (invoicingRule.enabled || proofPhotos.has(order.id)) ? (
                <p className="mt-1 flex flex-wrap gap-3 text-xs" data-testid="order-documents">
                  {invoicingRule.enabled ? (
                    <a href={`/api/orders/${order.id}/invoice`} className="font-medium text-kesari-700 hover:underline">
                      Tax invoice
                    </a>
                  ) : null}
                  {proofPhotos.has(order.id) ? (
                    <a href={proofPhotos.get(order.id)!.url} target="_blank" rel="noreferrer" className="font-medium text-kesari-700 hover:underline">
                      Photo at delivery
                    </a>
                  ) : null}
                </p>
              ) : null}
              {order.scheduledSlotStart && order.scheduledSlotEnd ? (
                <p className="text-xs font-medium text-kesari-700" data-testid="order-scheduled-slot">
                  Delivery {formatScheduledSlot(order.scheduledSlotStart, order.scheduledSlotEnd)}
                </p>
              ) : null}

              <ul className="mt-3 space-y-1 text-sm text-ink-600">
                {order.items.map((item) => (
                  <li key={item.id}>
                    <div className="flex justify-between gap-3">
                      <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
                        {item.productNameSnapshot} ·{" "}
                        {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                      </span>
                      <Money paise={item.lineTotalPaise} />
                    </div>
                    {item.fulfilmentStatus === "REMOVED" ? (
                      <p className="text-xs text-ink-500">Unavailable — refunded to your wallet</p>
                    ) : null}
                    {item.substituteNameSnapshot &&
                    (item.fulfilmentStatus === "SUBSTITUTION_PROPOSED" || item.fulfilmentStatus === "SUBSTITUTED") ? (
                      <p className="text-xs text-ink-500">
                        {item.fulfilmentStatus === "SUBSTITUTED" ? "Replaced with " : "Shop suggests "}
                        {item.substituteNameSnapshot}
                        {item.substituteQuantityMilli && item.substituteUnitSnapshot
                          ? ` · ${formatQuantity(item.substituteQuantityMilli, item.substituteUnitSnapshot)}`
                          : ""}
                        {item.substituteLineTotalPaise != null ? (
                          <>
                            {" "}
                            for <Money paise={item.substituteLineTotalPaise} />
                          </>
                        ) : null}
                      </p>
                    ) : null}
                    {item.fulfilmentStatus === "SUBSTITUTION_PROPOSED" ? (
                      <SubstitutionDecision orderId={order.id} itemId={item.id} />
                    ) : null}
                  </li>
                ))}
              </ul>

              {order.refundedPaise > 0 ? (
                <p className="mt-2 text-xs text-ink-500">
                  <Money paise={order.refundedPaise} /> refunded to your wallet for unavailable items.
                </p>
              ) : null}

              {order.source !== "SUBSCRIPTION" && cancellable.includes(order.status) ? (
                <CancelOrderButton orderId={order.id} orderNumber={order.orderNumber} />
              ) : null}

              {fulfilmentPlans.has(order.id) &&
              !["CANCELLED", "REFUNDED", "REFUND_PENDING"].includes(order.status) ? (
                <OrderFulfilmentCard orderId={order.id} info={fulfilmentPlans.get(order.id)!} />
              ) : null}

              {order.status === "OUT_FOR_DELIVERY" && deliveryCodes.get(order.id) ? (
                <DeliveryCodePanel
                  orderId={order.id}
                  maskedEmail={maskEmailAddress(user.email)}
                  locked={deliveryCodes.get(order.id)!.locked}
                  ticketNumber={deliveryCodes.get(order.id)!.ticketNumber}
                  resendsLeft={deliveryCodes.get(order.id)!.resendsLeft}
                />
              ) : null}

              {deliveryOrders.has(order.id) ? (
                <p className="mt-3 border-t border-cream-100 pt-3 text-sm text-ink-600">
                  {DELIVERY_STATUS_LABELS[deliveryOrders.get(order.id)!.status]} ·{" "}
                  {deliveryOrders.get(order.id)!.partnerName}
                </p>
              ) : null}

              {/*
                GS-042/NAV-004 + event layer: "Track delivery" for an order that
                has a rider and has not finished. The map and its 5-second poll
                start only when the customer opens it; the panel's own API
                decides what this viewer may see.
              */}
              {deliveryOrders.has(order.id) && isTrackableOrderStatus(order.status) ? (
                <div className="mt-3">
                  <TrackDeliveryButton orderId={order.id} />
                </div>
              ) : null}

              {order.status === "DELIVERED" || order.status === "DISPUTED" ? (
                <RateOrderForm
                  orderId={order.id}
                  canRateShop={myRatings.get(order.id)?.shop == null}
                  canRateRider={
                    myRatings.get(order.id)?.rider == null && deliveryOrders.get(order.id)?.status === "DELIVERED"
                  }
                  shopScore={myRatings.get(order.id)?.shop ?? null}
                  riderScore={myRatings.get(order.id)?.rider ?? null}
                />
              ) : null}

              {order.status === "DELIVERED" && order.orderType === "PERSONAL" ? (
                <div className="mt-3">
                  <LinkButton href={`/orders/${order.id}/return`} variant="secondary">
                    Return items
                  </LinkButton>
                </div>
              ) : null}

              {/*
                GS-058: while a dispute is open on this order, the card says so
                instead of inviting another report — a second case on the same
                order is refused by the service anyway.
              */}
              {liveDisputes.has(order.id) ? (
                <p className="mt-3 rounded-lg bg-cream-50 px-3 py-2 text-sm text-ink-700">
                  Dispute <span className="font-mono">{liveDisputes.get(order.id)!.caseNumber}</span> on this order:{" "}
                  <span className="font-medium">
                    {DISPUTE_STATUS_LABELS[liveDisputes.get(order.id)!.status].toLowerCase()}
                  </span>
                  .{" "}
                  <Link href={`/disputes/${liveDisputes.get(order.id)!.id}`} className="font-medium underline">
                    View the case
                  </Link>
                </p>
              ) : order.paidAt && order.status !== "PENDING" ? (
                <>
                  {/* Event layer: a delivered order can be disputed directly — case number at once. */}
                  {order.status === "DELIVERED" || order.status === "DISPUTED" ? (
                    <div className="mt-3">
                      <LinkButton href={`/orders/${order.id}/dispute`} variant="secondary">
                        Raise a dispute
                      </LinkButton>
                    </div>
                  ) : null}
                  <ReportIssueForm orderId={order.id} />
                </>
              ) : null}

              {order.status === "WALLET_INSUFFICIENT" ? (
                <div className="mt-3">
                  <Alert tone="danger">
                    This delivery could not be paid for. Top up your wallet and
                    retry from the subscription page.
                  </Alert>
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/orders?tab=${tab}${typeParam}&page=${n}`} />
    </>
  );
}
