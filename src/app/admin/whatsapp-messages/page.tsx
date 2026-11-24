import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { Alert, Badge, Card, PageHeader, inputClass } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { WHATSAPP_MESSAGE_KINDS, WHATSAPP_MESSAGE_STATUSES } from "@/server/db/schema";
import { whatsappTestRecipient } from "@/server/notifications/providers/whatsapp-meta";
import { listWhatsAppMessages, parseLogFilters, whatsAppDailyStats } from "@/server/whatsapp/shop-orders/log";
import { whatsAppFeatureState } from "@/server/whatsapp/shop-orders/state";
import { RETRYABLE_KINDS } from "@/server/whatsapp/shop-orders/dispatch";
import { customerWhatsAppState } from "@/server/whatsapp/customer/config";
import { canRetryWhatsApp, canSimulateWhatsApp, retryWhatsAppMessage, simulateCustomerInbound } from "@/server/whatsapp/customer/admin";

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

const PATH = "/admin/whatsapp-messages";

/** Back to the log with a short note (a thrown redirect, so never inside the try). */
function back(note: { notice?: string; error?: string }): never {
  const q = new URLSearchParams(Object.entries(note).filter(([, v]) => v) as [string, string][]);
  redirect(`${PATH}?${q.toString()}`);
}

async function retryAction(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  let note: { notice?: string; error?: string };
  try {
    await retryWhatsAppMessage(String(formData.get("id") ?? ""), user);
    note = { notice: "Queued again: it will be sent within a minute." };
  } catch (error) {
    note = { error: error instanceof AppError ? error.message : "Could not retry the message." };
  }
  revalidatePath(PATH);
  back(note);
}

async function simulateAction(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  let note: { notice?: string; error?: string };
  try {
    const result = await simulateCustomerInbound({ from: String(formData.get("from") ?? ""), text: String(formData.get("text") ?? "") }, user);
    note = { notice: `Simulated: ${result}. The replies are in the log below${(await customerWhatsAppState()).mode === "mock" ? " and in Admin → Test messages" : ""}.` };
  } catch (error) {
    note = { error: error instanceof AppError ? error.message : "Could not simulate the message." };
  }
  revalidatePath(PATH);
  back(note);
}

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
  const params = await searchParams;
  const filters = parseLogFilters(params);
  const [rows, stats, state, customer] = await Promise.all([listWhatsAppMessages(filters), whatsAppDailyStats(14), whatsAppFeatureState(), customerWhatsAppState()]);
  const testRecipient = whatsappTestRecipient();
  const mayRetry = canRetryWhatsApp(user.role);
  const maySimulate = customer.flagOn && canSimulateWhatsApp(user.role);
  const notice = typeof params.notice === "string" ? params.notice.slice(0, 300) : null;
  const error = typeof params.error === "string" ? params.error.slice(0, 300) : null;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="WhatsApp messages"
        description="New-order alerts to shops, and (docs/customer-whatsapp-2026-11) customer updates and chat replies, on WhatsApp (Meta Cloud API, or the mock outbox on the test site), with delivery status from Meta's webhook."
      />
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!state.flagOn ? <Alert tone="info">The flag whatsapp_shop_orders_enabled is off: no shop alerts are sent.</Alert> : null}
      {!customer.flagOn ? (
        <Alert tone="info">The flag whatsapp_customer_enabled is off: no customer updates or chat replies are sent.</Alert>
      ) : customer.problem ? (
        <Alert tone="warning" title="Customer WhatsApp dormant">
          {customer.problem}
        </Alert>
      ) : customer.mode === "mock" ? (
        <Alert tone="info">Customer WhatsApp is in mock mode: messages are written to Admin → Test messages, not sent to phones. Template updates also need rule whatsappCustomer.enabled.</Alert>
      ) : null}
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

      {maySimulate ? (
        <Card className="p-4" data-testid="whatsapp-simulate">
          <h2 className="mb-1 text-base font-semibold text-ink-900">Simulate a customer message (test site)</h2>
          <p className="mb-2 text-xs text-ink-500">
            Runs the shopping chat as if this number had written on WhatsApp: try &quot;milk&quot;, a PIN code, &quot;1&quot;, &quot;2&quot;, &quot;cart&quot;, &quot;checkout&quot;, STOP or START.
          </p>
          <form action={simulateAction} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
            <input name="from" required placeholder="+919876543210" className={inputClass} aria-label="From number" />
            <input name="text" required placeholder="Message" className={inputClass} aria-label="Message" maxLength={500} />
            <button className="rounded-lg border border-cream-200 px-3 py-2 text-sm" type="submit">
              Send
            </button>
          </form>
        </Card>
      ) : null}

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
            {mayRetry && m.status === "FAILED" && RETRYABLE_KINDS.includes(m.kind) ? (
              <form action={retryAction}>
                <input type="hidden" name="id" value={m.id} />
                <button className="rounded-lg border border-cream-200 px-3 py-1 text-xs" type="submit" data-testid="whatsapp-retry">
                  Retry
                </button>
              </form>
            ) : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="p-6 text-center text-sm text-ink-500">No messages match.</p> : null}
      </Card>
    </div>
  );
}
