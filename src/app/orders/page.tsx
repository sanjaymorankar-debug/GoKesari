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
import { TrackDeliveryButton } from "@/components/live-tracking-map";
import { RateOrderForm, ReportIssueForm } from "@/components/rating-actions";
import { SubstitutionDecision } from "@/components/substitution-decision";
import { formatQuantity } from "@/lib/money";
import { DISPUTE_STATUS_LABELS } from "@/lib/dispute-states";
import { isTrackableOrderStatus } from "@/lib/tracking";
import { getCurrentUser } from "@/server/authz/guards";
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
  searchParams: Promise<{ placed?: string; type?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const params = await searchParams;
  // Personal and business (B2B) orders are separate flows, listed apart.
  const showBusiness = can(user.role, PERMISSIONS.ORDER_PLACE_B2B);
  const orderType = showBusiness && params.type === "business" ? "B2B" : "PERSONAL";
  const orders = await listOrdersForUser(user.id, { limit: 50, orderType });
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
  // NEW-007: delivery photo and invoice links on delivered orders.
  const [proofPhotos, invoicingRule] = await Promise.all([
    proofPhotosForOrders(orders.filter((o) => o.status === "DELIVERED").map((o) => o.id)),
    getRule("invoicing"),
  ]);

  return (
    <>
      <PageHeader
        title="My Orders"
        description="Track everything you've ordered."
        action={<LinkButton href="/returns" variant="secondary">My returns</LinkButton>}
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

      {params.placed ? (
        <div className="mb-6">
          <Alert tone="success" title="Order placed">
            Your order has been confirmed and paid from your wallet.
          </Alert>
        </div>
      ) : null}

      {orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Your orders and subscription deliveries will appear here."
          action={<LinkButton href="/">Start shopping</LinkButton>}
        />
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} className="p-5" data-testid="order-card">
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
    </>
  );
}
