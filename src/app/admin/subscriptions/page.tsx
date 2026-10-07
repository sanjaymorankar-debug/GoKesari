import Link from "next/link";
import { redirect } from "next/navigation";

import { DeliveryStatusBadge, SubscriptionDeliveryList } from "@/components/subscription-delivery-list";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { addDays, formatShortDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { formatQuantity } from "@/lib/money";
import { SUBSCRIPTION_DELIVERY_STATUSES, type SubscriptionDeliveryStatus } from "@/lib/subscription-deliveries";
import { SUBSCRIPTION_STATUS_LABELS, subscriptionStatusLabel, subscriptionStatusTone } from "@/lib/subscription-status-view";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import type { Subscription } from "@/server/db/schema";
import { countDeliveriesByStatus, listSubscriptionDeliveries } from "@/server/services/subscription-schedule";
import { countSubscriptionsByStatus, listSubscriptionsAdmin } from "@/server/services/subscriptions";

export const metadata = { title: "Subscriptions" };
export const dynamic = "force-dynamic";

const STATUS_ORDER = ["DRAFT", "ACTIVE", "RENEWAL_PENDING", "PAYMENT_PENDING", "PAUSED", "COMPLETED", "CANCELLED"] as const;

/** SM-004 admin view: subscriptions by state, and each delivery's status for today and the coming days. */
export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SUBSCRIPTION_MANAGE_ANY)) redirect("/");
  const params = await searchParams;
  const status = (STATUS_ORDER as readonly string[]).includes(params.status ?? "")
    ? (params.status as Subscription["status"])
    : undefined;

  const today = todayIn(getEnv().APP_TIMEZONE);
  const [counts, rows, todayCounts, attention] = await Promise.all([
    countSubscriptionsByStatus(),
    listSubscriptionsAdmin({ status, limit: 200 }),
    countDeliveriesByStatus({ from: today, until: addDays(today, 1) }),
    listSubscriptionDeliveries({
      from: addDays(today, -7),
      until: addDays(today, 1),
      statuses: ["FAILED", "WALLET_INSUFFICIENT", "PAYMENT_FAILED", "CANCELLED", "RETURNED", "DISPUTED"],
      limit: 50,
    }),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscriptions"
        description="Every subscription by state, and each scheduled delivery with its own status."
      />

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter by status">
        <Link
          href="/admin/subscriptions"
          className={!status ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
        >
          All ({total})
        </Link>
        {STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={`/admin/subscriptions?status=${s}`}
            className={status === s ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}
          >
            {SUBSCRIPTION_STATUS_LABELS[s]} ({counts[s] ?? 0})
          </Link>
        ))}
      </nav>

      <Card className="p-5" data-testid="today-delivery-status">
        <h2 className="text-base font-semibold text-ink-900">Today&apos;s deliveries by status</h2>
        {Object.keys(todayCounts).length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No subscription deliveries today.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {SUBSCRIPTION_DELIVERY_STATUSES.filter((s) => todayCounts[s]).map((s) => (
              <span key={s} className="flex items-center gap-1 text-sm">
                <DeliveryStatusBadge status={s as SubscriptionDeliveryStatus} />
                <strong>{todayCounts[s]}</strong>
              </span>
            ))}
          </div>
        )}
      </Card>

      <SubscriptionDeliveryList
        title="Needs attention (last 7 days)"
        description="Deliveries that failed, were cancelled or could not be paid."
        showCustomer
        emptyText="Nothing failed in the last week."
        rows={attention.map((d) => ({
          id: d.delivery.id,
          deliveryDate: d.delivery.deliveryDate,
          status: d.delivery.status,
          quantityMilli: d.delivery.quantityMilli,
          reason: d.delivery.reason,
          orderNumber: d.orderNumber,
          customerName: d.customerName,
          productName: d.productName,
        }))}
      />

      {rows.length === 0 ? (
        <EmptyState title="No subscriptions in this state." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-50 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Shop</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Next / end</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {rows.map((r) => (
                <tr key={r.subscription.id}>
                  <td className="px-4 py-2">{r.customerName ?? "—"}</td>
                  <td className="px-4 py-2">
                    <Link href={`/subscriptions/${r.subscription.id}`} className="font-medium text-kesari-600 hover:underline">
                      {r.productName}
                    </Link>
                    <span className="text-ink-500"> · {formatQuantity(r.subscription.quantityMilli, r.unit)}</span>
                  </td>
                  <td className="px-4 py-2">{r.shopName}</td>
                  <td className="px-4 py-2">
                    <Badge tone={subscriptionStatusTone(r.subscription.status)}>
                      {subscriptionStatusLabel(r.subscription.status, r.subscription.renewalReason)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-ink-600">
                    {r.subscription.nextDeliveryDate ? `Next ${formatShortDate(r.subscription.nextDeliveryDate)}` : "—"}
                    {r.subscription.endDate ? ` · ends ${formatShortDate(r.subscription.endDate)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
