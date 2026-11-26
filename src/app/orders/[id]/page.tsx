import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RefundTimeline } from "@/components/aftercare/refund-timeline";
import { TicketList, toRowView } from "@/components/aftercare/ticket-views";
import { CancelOrderButton } from "@/components/cancel-order-button";
import { FlowsV3OrderActions } from "@/components/flows-v3/order-actions";
import { Alert, Card, LinkButton, Money, PageHeader, StatusBadge } from "@/components/ui";
import { formatQuantity } from "@/lib/money";
import { customerCancellableStatuses } from "@/lib/order-cancellation";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { PendingDeliveryLocation } from "@/components/onboarding-v2/pending-delivery-location";
import { getBoardLang } from "@/server/board-lang";
import { assertOrderViewer, listChargesForOrder } from "@/server/aftercare/order-view";
import { listRefundsForOrder } from "@/server/aftercare/refunds";
import { listTicketsForOrder } from "@/server/aftercare/support-tickets";
import { invoiceKindsForOrders, orderInvoiceLabel } from "@/server/services/invoices";
import { getOrder } from "@/server/services/orders";
import { platformInvoiceLabel, platformInvoicesForOrders } from "@/server/tax/delivery-invoice";
import { getRule } from "@/server/services/settings";
import { afterPackingCancellationRule, cancellationRule as effectiveCancellationRule } from "@/server/flows/wave2-rules";

export const metadata = { title: "Order details" };

/** Wording on the order page (Module 6, docs/hindi-marathi-2026-11/). */
const T = {
  title: L("Order {n}", "ऑर्डर {n}", "ऑर्डर {n}"),
  back: L("← My Orders", "← मेरे ऑर्डर", "← माझ्या ऑर्डर"),
  cancelledTitle: L("Order cancelled", "ऑर्डर रद्द हुआ", "ऑर्डर रद्द झाली"),
  cancelledText: L(
    "Your refund is shown below with each step as it happens.",
    "आपका रिफंड नीचे दिखाया गया है, हर कदम होते ही दिखेगा।",
    "तुमचा परतावा खाली दाखवला आहे, प्रत्येक टप्पा होताच दिसेल.",
  ),
  payment: L(" · Payment: ", " · भुगतान: ", " · पेमेंट: "),
  items: L("Items", "सामान", "वस्तू"),
  deliveryFee: L("Delivery fee", "डिलीवरी शुल्क", "डिलिव्हरी शुल्क"),
  discount: L("Discount", "छूट", "सूट"),
  cancellationFee: L("Cancellation fee (kept from the refund)", "रद्द करने का शुल्क (रिफंड से काटा गया)", "रद्द करण्याचे शुल्क (परताव्यातून कापले)"),
  refunds: L("Refunds", "रिफंड", "परतावे"),
  noRefunds: L("No refunds on this order.", "इस ऑर्डर पर कोई रिफंड नहीं।", "या ऑर्डरवर कोणताही परतावा नाही."),
  help: L("Help with this order", "इस ऑर्डर के लिए मदद", "या ऑर्डरसाठी मदत"),
  noTickets: L("No tickets on this order", "इस ऑर्डर पर कोई टिकट नहीं", "या ऑर्डरवर कोणतेही तिकीट नाही"),
  raiseTicket: L("Raise a ticket about this order", "इस ऑर्डर के बारे में टिकट बनाएँ", "या ऑर्डरबद्दल तिकीट नोंदवा"),
} as const;
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
  const [query, lang] = await Promise.all([searchParams, getBoardLang()]);
  const viewed = await assertOrderViewer(id, user).catch(() => null);
  if (!viewed) notFound();
  const [order, refunds, charges, tickets, cancellationRule, afterPackingRule, invoicingRule, invoiceKinds, gokesariInvoices] = await Promise.all([
    getOrder(id),
    listRefundsForOrder(id),
    listChargesForOrder(id),
    listTicketsForOrder(id, user),
    effectiveCancellationRule(), // docs/flows-v3/wave2.md (flag flow_f16)
    afterPackingCancellationRule(),
    getRule("invoicing"),
    // Billing v2 (QA D-112, D-113): the invoice's own kind, and GoKesari's s.9(5) invoices.
    invoiceKindsForOrders([id]),
    platformInvoicesForOrders([id]),
  ]);
  if (!order) notFound();
  const isBuyer = order.userId === user.id;
  // GoKesari's own invoices are the customer's (and operations'): the shop cannot open them.
  const ownInvoices = isBuyer || user.role === "ADMIN" || user.role === "OPERATOR" ? (gokesariInvoices.get(order.id) ?? []) : [];
  // TC-ORD-008: the server's own D10 rule, shared with My Orders.
  const cancellable: readonly string[] = customerCancellableStatuses({
    customerMayCancelUntil: cancellationRule.customerMayCancelUntil,
    afterPackingEnabled: afterPackingRule.enabled,
  });

  return (
    <>
      <PageHeader
        title={tr(T.title, lang).replace("{n}", order.orderNumber)}
        description={
          <Link href="/orders" className="underline">
            {tr(T.back, lang)}
          </Link>
        }
      />
      {/* docs/onboarding-v2-2026-11: an order still waiting for its delivery location asks for it here. */}
      {order.userId === user.id ? <PendingDeliveryLocation userId={user.id} onlyOrderId={order.id} /> : null}
      {query.cancelled ? (
        <div className="mb-4">
          <Alert tone="success" title={tr(T.cancelledTitle, lang)}>
            {tr(T.cancelledText, lang)}
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
              {/* TC-SPI-006: how the order is paid, whatever the method. */}
              {paymentMethodLabel(order.paymentMethod) ? (
                <span data-testid="order-payment-method">{tr(T.payment, lang)}{paymentMethodLabel(order.paymentMethod)}</span>
              ) : null}
            </p>
            <ul className="mt-3 space-y-1 text-sm text-ink-600">
              {order.items.map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span className={item.fulfilmentStatus === "REMOVED" ? "line-through" : undefined}>
                    {item.productNameSnapshot} · {formatQuantity(item.quantityMilli, item.unitSnapshot)}
                    {/* TC-SPI-006: the price paid per unit at purchase. */}
                    <span className="ml-1 text-xs text-ink-500" data-testid="order-line-unit-price">
                      @ <Money paise={item.unitPricePaise} /> / {item.unitSnapshot}
                    </span>
                    {/* D-91: the MRP in force when the order was placed. */}
                    {item.mrpPaise != null ? (
                      <span className="ml-1 text-xs text-ink-500" data-testid="order-line-mrp">
                        (MRP <Money paise={item.mrpPaise} />)
                      </span>
                    ) : null}
                  </span>
                  <Money paise={item.lineTotalPaise} />
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1 border-t border-cream-100 pt-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-600">{tr(T.items, lang)}</dt>
                <dd>
                  <Money paise={order.subtotalPaise} />
                </dd>
              </div>
              {order.deliveryFeePaise > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-ink-600">{tr(T.deliveryFee, lang)}</dt>
                  <dd>
                    <Money paise={order.deliveryFeePaise} />
                  </dd>
                </div>
              ) : null}
              {order.discountPaise > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-ink-600">{tr(T.discount, lang)}</dt>
                  <dd>
                    −<Money paise={order.discountPaise} />
                  </dd>
                </div>
              ) : null}
              {charges.map((c) => (
                <div key={c.id} className="flex justify-between" data-testid="order-charge">
                  <dt className="text-ink-600">{tr(T.cancellationFee, lang)}</dt>
                  <dd>
                    <Money paise={c.amountPaise} />
                  </dd>
                </div>
              ))}
            </dl>
            {order.status === "DELIVERED" && (invoicingRule.enabled || ownInvoices.length > 0) ? (
              <p className="mt-3 flex flex-wrap gap-3 border-t border-cream-100 pt-3 text-sm" data-testid="order-documents">
                {invoicingRule.enabled ? (
                  <a href={`/api/orders/${order.id}/invoice`} className="font-medium text-kesari-700 hover:underline">
                    {orderInvoiceLabel(invoiceKinds.get(order.id))}
                  </a>
                ) : null}
                {ownInvoices.map((g) => (
                  <a key={g.id} href={`/api/delivery-invoices/${g.id}/pdf`} className="font-medium text-kesari-700 hover:underline">
                    {platformInvoiceLabel(g.kind)}
                  </a>
                ))}
              </p>
            ) : null}
            {isBuyer && order.source !== "SUBSCRIPTION" && cancellable.includes(order.status) ? (
              <CancelOrderButton orderId={order.id} orderNumber={order.orderNumber} lang={lang} />
            ) : null}
            {/* docs/flows-v3/wave2.md: ask the shop to cancel (F16), cancel the rest (F20), referral after payment (F2). */}
            {isBuyer ? <FlowsV3OrderActions order={order} userId={user.id} /> : null}
          </Card>

          <section>
            <h2 className="mb-2 text-lg font-semibold text-ink-900">{tr(T.refunds, lang)}</h2>
            {refunds.length === 0 ? (
              <p className="text-sm text-ink-500">{tr(T.noRefunds, lang)}</p>
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
          <h2 className="text-lg font-semibold text-ink-900">{tr(T.help, lang)}</h2>
          <TicketList rows={tickets.map(toRowView)} hrefBase="/support" emptyTitle={tr(T.noTickets, lang)} />
          {isBuyer ? (
            <LinkButton href={`/support?orderId=${order.id}#new`} variant="secondary">
              {tr(T.raiseTicket, lang)}
            </LinkButton>
          ) : null}
        </aside>
      </div>
    </>
  );
}
