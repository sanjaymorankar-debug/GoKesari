import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RefundTimeline } from "@/components/aftercare/refund-timeline";
import { TicketList, toRowView } from "@/components/aftercare/ticket-views";
import { CancelOrderButton } from "@/components/cancel-order-button";
import { Alert, Card, LinkButton, Money, PageHeader, StatusBadge } from "@/components/ui";
import { formatQuantity } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { assertOrderViewer, listChargesForOrder } from "@/server/aftercare/order-view";
import { listRefundsForOrder } from "@/server/aftercare/refunds";
import { listTicketsForOrder } from "@/server/aftercare/support-tickets";
import { getOrder } from "@/server/services/orders";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Order details" };
export const dynamic = "force-dynamic";

/**
 * The customer's order page (batch-2026-10 WS-C): what was ordered and paid,
 * cancelling with the fee shown first (F6.1.3), the refund timeline (F6.2.3)
 * and the order's help desk tickets (F6.3.3).
 */
export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cancelled?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const query = await searchParams;
  const viewed = await assertOrderViewer(id, user).catch(() => null);
  if (!viewed) notFound();
  const [order, refunds, charges, tickets, cancellationRule, afterPackingRule] = await Promise.all([
    getOrder(id),
    listRefundsForOrder(id),
    listChargesForOrder(id),
    listTicketsForOrder(id, user),
    getRule("cancellation"),
    getRule("afterPackingCancellation"),
  ]);
  if (!order) notFound();
  const isBuyer = order.userId === user.id;
  const cancellable: readonly string[] = [
    ...(cancellationRule.customerMayCancelUntil === "PREPARING" ? ["CONFIRMED", "ACCEPTED", "PREPARING"] : ["CONFIRMED"]),
    ...(afterPackingRule.enabled ? ["READY", "ASSIGNED"] : []),
    "PICKED_UP",
    "OUT_FOR_DELIVERY",
  ];

  return (
    <>
      <PageHeader
        title={`Order ${order.orderNumber}`}
        description={
          <Link href="/orders" className="underline">
            ← My Orders
          </Link>
        }
      />
      {query.cancelled ? (
        <div className="mb-4">
          <Alert tone="success" title="Order cancelled">
            Your refund is shown below with each step as it happens.
          </Alert>
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <StatusBadge status={order.status} />
              <span className="font-semibold text-ink-900">
                <Money paise={order.totalPaise} />
              </span>
            </div>
            <p className="text-sm font-medium text-ink-900">{order.shopName}</p>
            <p className="text-xs text-ink-500">
              {new Date(order.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
              {order.paymentMethod === "COD" ? " · cash on delivery" : ""}
            </p>
            <ul className="mt-3 space-y-1 text-sm text-ink-600">
              {order.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
                    {item.productNameSnapshot} · {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                  </span>
                  <Money paise={item.lineTotalPaise} />
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1 border-t border-cream-100 pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-600">Items</dt>
                <dd>
                  <Money paise={order.subtotalPaise} />
                </dd>
              </div>
              {order.deliveryFeePaise > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-ink-600">Delivery fee</dt>
                  <dd>
                    <Money paise={order.deliveryFeePaise} />
                  </dd>
                </div>
              ) : null}
              {order.discountPaise > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-ink-600">Discount</dt>
                  <dd>
                    −<Money paise={order.discountPaise} />
                  </dd>
                </div>
              ) : null}
              {charges.map((c) => (
                <div key={c.id} className="flex justify-between" data-testid="order-charge">
                  <dt className="text-ink-600">Cancellation fee (kept from the refund)</dt>
                  <dd>
                    <Money paise={c.amountPaise} />
                  </dd>
                </div>
              ))}
            </dl>
            {isBuyer && order.source !== "SUBSCRIPTION" && cancellable.includes(order.status) ? (
              <CancelOrderButton orderId={order.id} orderNumber={order.orderNumber} />
            ) : null}
          </Card>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-ink-900">Refunds</h2>
            {refunds.length === 0 ? (
              <p className="text-sm text-ink-500">No refunds on this order.</p>
            ) : (
              <RefundTimeline
                refunds={refunds.map((r) => ({
                  ...r,
                  createdAt: r.createdAt.toISOString(),
                  timeline: r.timeline.map((s) => ({ ...s, at: s.at.toISOString() })),
                }))}
              />
            )}
          </section>
        </div>

        <aside className="space-y-3">
          <h2 className="text-lg font-semibold text-ink-900">Help with this order</h2>
          <TicketList rows={tickets.map(toRowView)} hrefBase="/support" emptyTitle="No tickets on this order" />
          {isBuyer ? (
            <LinkButton href={`/support?orderId=${order.id}#new`} variant="secondary">
              Raise a ticket about this order
            </LinkButton>
          ) : null}
        </aside>
      </div>
    </>
  );
}
