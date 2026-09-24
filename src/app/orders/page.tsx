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
import { SubstitutionDecision } from "@/components/substitution-decision";
import { formatQuantity } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getDeliveryOrdersForOrders } from "@/server/services/delivery-assignment";
import { listOrdersForUser } from "@/server/services/orders";

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
  const deliveryOrders = await getDeliveryOrdersForOrders(orders.map((o) => o.id));

  return (
    <>
      <PageHeader title="My Orders" description="Track everything you've ordered." />

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
                  <span className="text-sm text-ink-500">
                    {order.orderNumber}
                  </span>
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
                {order.deliveryDate ? ` · for ${order.deliveryDate}` : ""}
              </p>

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

              {order.status === "OUT_FOR_DELIVERY" && deliveryOrders.get(order.id)?.deliveryOtp ? (
                <p
                  className="mt-3 rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-700"
                  data-testid="delivery-otp"
                >
                  Delivery code:{" "}
                  <span className="font-mono text-lg font-bold tracking-widest">
                    {deliveryOrders.get(order.id)!.deliveryOtp}
                  </span>{" "}
                  — share it with the rider only when you receive your order.
                </p>
              ) : null}

              {deliveryOrders.has(order.id) ? (
                <p className="mt-3 border-t border-cream-100 pt-3 text-sm text-ink-600">
                  {DELIVERY_STATUS_LABELS[deliveryOrders.get(order.id)!.status]} ·{" "}
                  {deliveryOrders.get(order.id)!.partnerName}
                </p>
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
