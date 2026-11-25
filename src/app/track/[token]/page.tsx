/**
 * docs/guest-checkout-2026-11: follow an order without signing in. The link itself is the
 * permission (signed with AUTH_SECRET, expires after 30 days). Shows the purchase's status per shop,
 * items and totals, and the combined timeline; personal data limited to the first name and a masked
 * mobile. Read-only. 404 when the flags are off or the link is wrong, changed or expired.
 */
import Link from "next/link";
import { notFound } from "next/navigation";

import { OrderGroupTimeline } from "@/components/guest-checkout/order-group-timeline";
import { Card, Money, PageHeader } from "@/components/ui";
import { getTrackingView, isGuestCheckoutOn } from "@/server/guest-checkout/tracking";
import { verifyTrackingToken } from "@/server/guest-checkout/token";

export const metadata = { title: "Track order", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export default async function TrackOrderPage({ params }: { params: Promise<{ token: string }> }) {
  if (!(await isGuestCheckoutOn())) notFound();
  const { token } = await params;
  const check = verifyTrackingToken(decodeURIComponent(token));
  if (!check.ok) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader title="Track order" />
        <Card className="p-4 text-sm text-ink-700" data-testid="track-link-invalid">
          {check.reason === "EXPIRED" ? "This tracking link has expired." : "This tracking link is not valid."}{" "}
          <Link href="/track" className="font-medium text-kesari-700 underline">
            Find your order
          </Link>{" "}
          with its reference instead.
        </Card>
      </div>
    );
  }
  const view = await getTrackingView(check.target);
  if (!view) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="track-page">
      <PageHeader
        title={`Order ${view.reference}`}
        description={`${view.customer.firstName ? `For ${view.customer.firstName}` : "Your order"}${view.customer.maskedPhone ? ` (${view.customer.maskedPhone})` : ""} · placed ${when(view.placedAt)}`}
      />
      <OrderGroupTimeline timeline={view.timeline} />
      {view.orders.map((o) => (
        <Card key={o.id} className="p-4" data-testid="track-order">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-ink-900">{o.shopName}</p>
              <p className="text-xs text-ink-500">{o.orderNumber}</p>
            </div>
            <span className="rounded-full bg-cream-100 px-2.5 py-1 text-xs font-semibold text-ink-800">{o.statusLabel}</span>
          </div>
          {o.promisedByAt && o.status !== "DELIVERED" ? <p className="mt-1 text-xs text-ink-600">Expected by {when(o.promisedByAt)}</p> : null}
          <ul className="mt-3 divide-y divide-cream-200 text-sm">
            {o.items.map((i, idx) => (
              <li key={idx} className={`flex justify-between gap-3 py-1.5 ${i.removed ? "text-ink-500 line-through" : "text-ink-800"}`}>
                <span>
                  {i.name} × {i.quantity}
                </span>
                <Money paise={i.lineTotalPaise} />
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-0.5 border-t border-cream-200 pt-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-600">Delivery</dt>
              <dd>{o.deliveryFeePaise > 0 ? <Money paise={o.deliveryFeePaise} /> : "Free"}</dd>
            </div>
            {o.discountPaise > 0 ? (
              <div className="flex justify-between">
                <dt className="text-ink-600">Discount</dt>
                <dd>
                  −<Money paise={o.discountPaise} />
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between font-semibold">
              <dt>Total{o.paymentMethod === "COD" ? " (cash on delivery)" : ""}</dt>
              <dd>
                <Money paise={o.totalPaise} />
              </dd>
            </div>
          </dl>
          {o.liveTrackingUrl ? (
            <Link href={o.liveTrackingUrl} className="mt-3 inline-block text-sm font-medium text-kesari-700 hover:underline" data-testid="track-live-link">
              Live map of the rider (sign in) →
            </Link>
          ) : null}
        </Card>
      ))}
      {view.orders.length > 1 ? (
        <Card className="flex justify-between p-4 text-base font-semibold text-ink-900">
          <span>Total</span>
          <Money paise={view.totalPaise} />
        </Card>
      ) : null}
      <p className="text-xs text-ink-500">
        Questions about this order? <Link href="/support" className="underline">Contact support</Link> with the reference {view.reference}.
      </p>
    </div>
  );
}
