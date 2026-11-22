import { redirect } from "next/navigation";

import { Alert, Badge, Card, PageHeader, inputClass } from "@/components/ui";
import { formatIst } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { WHATSAPP_MESSAGE_KINDS, WHATSAPP_MESSAGE_STATUSES } from "@/server/db/schema";
import { whatsappTestRecipient } from "@/server/notifications/providers/whatsapp-meta";
import { listWhatsAppMessages, parseLogFilters, whatsAppDailyStats } from "@/server/whatsapp/shop-orders/log";
import { whatsAppFeatureState } from "@/server/whatsapp/shop-orders/state";

export const metadata = { title: "WhatsApp messages" };
export const dynamic = "force-dynamic";

const TONES: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  QUEUED: "neutral",
  SENDING: "neutral",
  SENT: "info",
  DELIVERED: "success",
  READ: "success",
  FAILED: "danger",
  SKIPPED: "warning",
};

/**
 * docs/smart-shopping-2026-11 (feature 3): every WhatsApp message to shops —
 * order alerts, status updates, number checks and replies — with Meta's
 * message id, its status and any error, plus sent / delivered / read / failed
 * per day. Admins and operators (order:view:any).
 */
export default async function WhatsAppMessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.ORDER_VIEW_ANY)) redirect("/");
  const filters = parseLogFilters(await searchParams);
  const [rows, stats, state] = await Promise.all([listWhatsAppMessages(filters), whatsAppDailyStats(14), whatsAppFeatureState()]);
  const testRecipient = whatsappTestRecipient();
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="WhatsApp messages" description="New-order alerts and updates sent to shops on WhatsApp (Meta Cloud API), with delivery status from Meta's webhook." />
      {!state.flagOn ? <Alert tone="info">The flag whatsapp_shop_orders_enabled is off: nothing is sent.</Alert> : null}
      {state.flagOn && state.providerProblem ? (
        <Alert tone="warning" title="Dormant">
          {state.providerProblem}
        </Alert>
      ) : null}
      {testRecipient ? <Alert tone="info">Test site: every WhatsApp message goes to {testRecipient}; the log shows who it was meant for.</Alert> : null}

      <Card className="overflow-x-auto p-4" data-testid="whatsapp-stats">
        <h2 className="mb-2 text-base font-semibold text-ink-900">Last 14 days (IST)</h2>
        <table className="w-full min-w-[480px] text-sm">
          <thead className="text-left text-xs text-ink-500">
            <tr>
              <th className="py-1">Day</th>
              <th>Sent</th>
              <th>Delivered</th>
              <th>Read</th>
              <th>Failed</th>
              <th>Skipped</th>
              <th>Queued</th>
              <th>All</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((d) => (
              <tr key={d.day} className="border-t border-cream-200">
                <td className="py-1">{d.day}</td>
                <td>{d.sent}</td>
                <td>{d.delivered}</td>
                <td>{d.read}</td>
                <td className={d.failed ? "font-semibold text-red-700" : undefined}>{d.failed}</td>
                <td>{d.skipped}</td>
                <td>{d.queued}</td>
                <td>{d.total}</td>
              </tr>
            ))}
            {stats.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-3 text-center text-ink-500">
                  No messages yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      <form className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8" data-testid="whatsapp-filters">
        <select name="status" defaultValue={filters.status ?? ""} className={inputClass} aria-label="Status">
          <option value="">Any status</option>
          {WHATSAPP_MESSAGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="kind" defaultValue={filters.kind ?? ""} className={inputClass} aria-label="Kind">
          <option value="">Any kind</option>
          {WHATSAPP_MESSAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input name="shop" defaultValue={filters.shop ?? ""} placeholder="Shop" className={inputClass} />
        <input name="order" defaultValue={filters.order ?? ""} placeholder="Order number" className={inputClass} />
        <input name="number" defaultValue={filters.number ?? ""} placeholder="Mobile number" className={inputClass} />
        <input name="from" type="date" defaultValue={filters.from ?? ""} className={inputClass} aria-label="From" />
        <input name="to" type="date" defaultValue={filters.to ?? ""} className={inputClass} aria-label="To" />
        <button className="rounded-lg border border-cream-200 px-3 py-2 text-sm" type="submit">
          Filter
        </button>
      </form>

      <Card className="divide-y divide-cream-200">
        {rows.map(({ message: m, shopName, orderNumber }) => (
          <div key={m.id} className="space-y-1 p-3 text-sm" data-testid="whatsapp-log-row">
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
              <Badge tone={TONES[m.status] ?? "neutral"}>{m.status}</Badge>
              <span>{m.kind}</span>
              <span>{formatIst(m.createdAt)}</span>
              {shopName ? <span>· {shopName}</span> : null}
              {orderNumber ? <span>· order {orderNumber}</span> : null}
              <span>
                · to {m.intendedTo}
                {m.sentTo && m.sentTo !== m.intendedTo ? ` (sent to ${m.sentTo})` : ""}
              </span>
              {m.template ? <span>· template {m.template}</span> : null}
            </p>
            {m.body ? <p className="whitespace-pre-line break-words text-ink-900">{m.body}</p> : null}
            <p className="text-xs text-ink-500">
              {m.metaMessageId ? `Meta id ${m.metaMessageId}` : "No Meta id"}
              {m.sentAt ? ` · sent ${formatIst(m.sentAt)}` : ""}
              {m.deliveredAt ? ` · delivered ${formatIst(m.deliveredAt)}` : ""}
              {m.readAt ? ` · read ${formatIst(m.readAt)}` : ""}
              {m.failedAt ? ` · failed ${formatIst(m.failedAt)}` : ""}
              {m.fallbackAt ? ` · fallback sent ${formatIst(m.fallbackAt)}` : ""}
            </p>
            {m.error ? (
              <p className="text-xs text-red-700">
                {m.errorCode ? `[${m.errorCode}] ` : ""}
                {m.error}
              </p>
            ) : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="p-6 text-center text-sm text-ink-500">No messages match.</p> : null}
      </Card>
    </div>
  );
}
