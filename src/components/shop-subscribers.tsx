import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { formatQuantity, MILLI_PER_UNIT } from "@/lib/money";
import { formatShortDate } from "@/lib/dates";
import { copiesLabel, scheduleLabel } from "@/lib/periodicals";
import { slotLabel } from "@/lib/subscription-plans";
import { subscriptionStatusLabel, subscriptionStatusTone } from "@/lib/subscription-status-view";
import type { ShopSubscriber } from "@/server/services/newspaper-subscriptions";
import type { PrepSheet } from "@/server/services/subscription-plans";

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
    const name = s.plan?.name ?? s.productName;
    const current = byItem.get(name) ?? { name, count: 0, milli: 0, unit: s.unit, isPeriodical: s.isPeriodical };
    current.count += 1;
    current.milli += s.quantityMilli;
    byItem.set(name, current);
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
                {s.plan ? `${s.plan.name} (${s.productName})` : s.productName} · {amount(s)} · {scheduleLabel(s)}
                {s.plan ? ` · ${slotLabel(s.plan.slot, s.plan.slotWindow)}` : ""}
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

/**
 * The shop's prep sheet (docs/subscription-plans-2026-11): for each plan (or
 * product without a plan) and each of the next days, how many deliveries and
 * how much in all — what the kitchen, dairy or paper round must get ready.
 */
export function PrepSheetTable({ sheet }: { sheet: PrepSheet }) {
  if (sheet.rows.length === 0) return null;
  const qty = (row: PrepSheet["rows"][number], milli: number) =>
    row.isPeriodical ? copiesLabel(milli / MILLI_PER_UNIT) : formatQuantity(milli, row.unit);
  return (
    <Card className="overflow-x-auto p-0" data-testid="prep-sheet">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="px-4 pb-1 pt-4 text-left">
          <span className="block text-lg font-semibold text-ink-900">Next {sheet.dates.length} days — what to prepare</span>
          <span className="block text-xs font-normal text-ink-600">Deliveries and total quantity per plan, after skips, pauses and one-day changes.</span>
        </caption>
        <thead>
          <tr className="border-b border-cream-200 text-left text-xs text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">Plan / item</th>
            {sheet.dates.map((d) => (
              <th key={d} scope="col" className="px-2 py-2 text-right font-medium">
                {formatShortDate(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row) => (
            <tr key={row.key} className="border-b border-cream-100 last:border-0">
              <th scope="row" className="px-4 py-2 text-left font-medium text-ink-900">
                {row.label}
                {row.slot ? <span className="block text-xs font-normal text-ink-500">{slotLabel(row.slot, row.slotWindow)}</span> : null}
              </th>
              {sheet.dates.map((d) => {
                const cell = row.days[d];
                return (
                  <td key={d} className="px-2 py-2 text-right tabular-nums">
                    {cell.deliveries === 0 ? (
                      <span className="text-ink-400">—</span>
                    ) : (
                      <>
                        <span className="font-semibold text-ink-900">{cell.deliveries}</span>
                        <span className="block text-xs text-ink-500">{qty(row, cell.quantityMilli)}</span>
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
