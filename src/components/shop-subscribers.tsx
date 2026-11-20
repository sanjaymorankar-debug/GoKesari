import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { formatQuantity, MILLI_PER_UNIT } from "@/lib/money";
import { copiesLabel, scheduleLabel } from "@/lib/periodicals";
import { subscriptionStatusLabel, subscriptionStatusTone } from "@/lib/subscription-status-view";
import type { ShopSubscriber } from "@/server/services/newspaper-subscriptions";

/** A subscriber is "new" for this many days after subscribing. */
const NEW_FOR_DAYS = 3;

function amount(s: Pick<ShopSubscriber, "isPeriodical" | "quantityMilli" | "unit">): string {
  return s.isPeriodical ? copiesLabel(s.quantityMilli / MILLI_PER_UNIT) : formatQuantity(s.quantityMilli, s.unit);
}

/**
 * The shop's subscriber list (docs/newspaper-subscriptions-2026-11): a summary
 * per item (how many subscribers, how much per delivery) — the vendor's
 * standing order to their supplier — then every running subscription with
 * who, where, what and how often. New subscribers are marked.
 */
export function ShopSubscribers({ subscribers, now = new Date() }: { subscribers: ShopSubscriber[]; now?: Date }) {
  if (subscribers.length === 0) {
    return (
      <EmptyState
        title="No subscribers yet"
        description="When a customer subscribes to milk, bread, a newspaper or a magazine from your shop, you are told at once and they appear here."
      />
    );
  }

  const byItem = new Map<string, { name: string; count: number; milli: number; unit: string; isPeriodical: boolean }>();
  for (const s of subscribers) {
    if (s.status === "PAUSED") continue;
    const current = byItem.get(s.productName) ?? { name: s.productName, count: 0, milli: 0, unit: s.unit, isPeriodical: s.isPeriodical };
    current.count += 1;
    current.milli += s.quantityMilli;
    byItem.set(s.productName, current);
  }
  const customers = new Set(subscribers.map((s) => `${s.customerName}|${s.address ?? ""}`)).size;
  const newSince = now.getTime() - NEW_FOR_DAYS * 24 * 60 * 60 * 1000;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="text-lg font-semibold text-ink-900">
          {customers} customer{customers === 1 ? "" : "s"} · {subscribers.length} subscription{subscribers.length === 1 ? "" : "s"}
        </h2>
        <p className="mt-1 text-sm text-ink-600">Running subscriptions per item (paused ones not counted):</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Subscriptions per item">
          {[...byItem.values()]
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .map((item) => (
              <li key={item.name} className="flex justify-between gap-2 rounded-lg bg-cream-50 px-3 py-2 text-sm">
                <span className="font-medium text-ink-900">{item.name}</span>
                <span className="text-ink-600">
                  {item.count} subscriber{item.count === 1 ? "" : "s"} · {amount({ isPeriodical: item.isPeriodical, quantityMilli: item.milli, unit: item.unit })} a delivery
                </span>
              </li>
            ))}
        </ul>
      </Card>

      <Card className="divide-y divide-cream-200" data-testid="shop-subscriber-list">
        {subscribers.map((s) => (
          <div key={s.subscriptionId} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="font-medium text-ink-900">
                {s.customerName}
                {s.createdAt.getTime() >= newSince ? (
                  <span className="ml-2 align-middle">
                    <Badge tone="success">New</Badge>
                  </span>
                ) : null}
              </p>
              <p className="text-sm text-ink-700">
                {s.productName} · {amount(s)} · {scheduleLabel(s)}
              </p>
              <p className="text-sm text-ink-600">{s.address ?? "No delivery address yet"}</p>
              <p className="text-xs text-ink-500">
                From {formatDisplayDate(s.startDate)}
                {s.endDate ? ` to ${formatDisplayDate(s.endDate)}` : ""}
                {s.nextDeliveryDate ? ` · next delivery ${formatDisplayDate(s.nextDeliveryDate)}` : ""}
                {s.status === "PAUSED" && s.pauseFrom && s.pauseUntil
                  ? ` · paused ${formatDisplayDate(s.pauseFrom)} – ${formatDisplayDate(s.pauseUntil)}`
                  : ""}
              </p>
            </div>
            <Badge tone={subscriptionStatusTone(s.status)}>{subscriptionStatusLabel(s.status, null)}</Badge>
          </div>
        ))}
      </Card>
    </div>
  );
}
