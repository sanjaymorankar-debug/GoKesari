import Link from "next/link";
import { redirect } from "next/navigation";

import { PicoOpsActions, PicoRefillButton } from "@/components/pico-delivery";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { canConfigureDelivery, canSeeDelivery } from "@/server/delivery/access";
import { listShipments, picoOverview, recentApiLogs, recentEvents, SHIPMENT_FILTERS, type ShipmentFilter } from "@/server/delivery/pico/admin";
import { BOOKING_UNCONFIRMED } from "@/server/delivery/pico/service";
import { picoCancellable, picoStateLabel } from "@/server/delivery/pico/status";

import { DeliveryNav, istTime, paise } from "../delivery-nav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pico Xpress — gokesari.com delivery partner" };

const FILTERS: { key: ShipmentFilter; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "problems", label: "Needs attention" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

/** Admin → Delivery management → Pico Xpress (docs/pico-xpress-2026-11). All times IST. */
export default async function PicoAdminPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!canSeeDelivery(user.role)) redirect("/");
  const sp = await searchParams;
  const filter: ShipmentFilter = sp.filter === "all" || (sp.filter && sp.filter in SHIPMENT_FILTERS) ? (sp.filter as ShipmentFilter) : "live";
  const q = (sp.q ?? "").slice(0, 40);
  const [o, shipments, logs, events] = await Promise.all([picoOverview(), listShipments(filter, q), recentApiLogs(40), recentEvents(40)]);
  const canEdit = canConfigureDelivery(user.role);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Pico Xpress — gokesari.com delivery partner" />
      <DeliveryNav current="pico" />

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="space-y-1 p-4 text-sm">
          <p className="font-semibold text-ink-900">Switches</p>
          <p>
            Pico Xpress: <Badge tone={o.enabled ? "success" : "neutral"}>{o.enabled ? "ON" : "OFF"}</Badge>
          </p>
          <p>
            Live location (paid add-on): <Badge tone={o.liveLocation ? "warning" : "neutral"}>{o.liveLocation ? "ON" : "OFF"}</Badge>
          </p>
          <Link href="/admin/feature-flags" className="text-xs font-medium text-kesari-700 hover:underline">
            Change in Feature flags →
          </Link>
        </Card>
        <Card className="space-y-1 p-4 text-sm">
          <p className="font-semibold text-ink-900">Connection ({o.env === "PRODUCTION" ? "Pico production" : "Pico staging"})</p>
          {o.configured ? (
            <>
              <p>
                API: <span className="font-mono">{o.host}</span> <Badge tone="success">keys set</Badge>
              </p>
              <p>
                Webhook token: <Badge tone={o.webhookTokenSet ? "success" : "danger"}>{o.webhookTokenSet ? "set" : "missing"}</Badge>
              </p>
            </>
          ) : (
            <Alert tone="warning">{o.configProblem}</Alert>
          )}
          <p className="text-xs text-ink-600">Webhooks: /api/webhooks/picoxpress/shipment-status and /location (Bearer token).</p>
        </Card>
        <Card className="space-y-1 p-4 text-sm">
          <p className="font-semibold text-ink-900">AWB pool</p>
          <p>
            Available <b>{o.pool.AVAILABLE}</b> · allocated {o.pool.ALLOCATED} · used {o.pool.USED} · cancelled {o.pool.CANCELLED}
          </p>
          <p className="text-xs text-ink-600">
            Refilled with {o.rules.awbFetchBatch} numbers when fewer than {o.rules.awbRefillThreshold} are left (at booking).
          </p>
          {o.pool.AVAILABLE < o.rules.awbRefillThreshold ? <Badge tone="warning">Below threshold</Badge> : null}
          {canEdit && o.configured ? <PicoRefillButton /> : null}
        </Card>
      </div>

      <Card className="space-y-1 p-4 text-sm">
        <p className="font-semibold text-ink-900">Settings (Business rules → picoXpress)</p>
        <p>
          <b>Bill-to:</b> {o.rules.billTo.unitName}, GSTIN {o.rules.billTo.gstNumber}, {o.rules.billTo.addressLine1}, {o.rules.billTo.addressLine2}, {o.rules.billTo.city} {o.rules.billTo.pincode}
        </p>
        <p>
          <b>Pickup type:</b> {o.rules.defaultPickupType} by default
          {Object.keys(o.rules.pickupTypeByShopType).length ? `; ${Object.entries(o.rules.pickupTypeByShopType).map(([k, v]) => `${k} → ${v}`).join(", ")}` : ""}
        </p>
        <p>
          <b>Box weight when products have none:</b> {o.rules.defaultBoxWeightGrams} g
          {Object.keys(o.rules.boxWeightGramsByShopType).length ? `; ${Object.entries(o.rules.boxWeightGramsByShopType).map(([k, v]) => `${k}: ${v} g`).join(", ")}` : ""} · up to {o.rules.maxBoxes} boxes
        </p>
        <p>
          <b>PAN-only shops:</b> {o.rules.nonGstShops === "HIDE_OPTION" ? "option hidden (Pico needs a GSTIN)" : "AGTCI's GSTIN is sent (only with Pico's written OK)"} · <b>E-way bill</b> above {paise(o.rules.ewayBillThresholdPaise)}
        </p>
        <p>
          <b>Webhook IP allowlist:</b> {o.rules.webhookIpAllowlist.length ? o.rules.webhookIpAllowlist.join(", ") : "none yet (token only)"}
        </p>
        <Link href="/admin/settings" className="text-xs font-medium text-kesari-700 hover:underline">
          Change in Business rules → picoXpress →
        </Link>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <nav className="flex flex-wrap gap-1 text-sm" aria-label="Shipment filter">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/admin/delivery/pico?filter=${f.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                aria-current={f.key === filter ? "page" : undefined}
                className={`rounded-full px-3 py-1 ${f.key === filter ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700 hover:bg-cream-200"}`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
          <form className="flex gap-2" action="/admin/delivery/pico">
            <input type="hidden" name="filter" value={filter} />
            <input name="q" defaultValue={q} placeholder="Order no., AWB or shop" className="rounded-lg border border-cream-200 px-2 py-1 text-sm" aria-label="Search shipments" />
          </form>
        </div>
        {shipments.length === 0 ? <p className="text-sm text-ink-600">No shipments here.</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-ink-500">
              <tr>
                <th className="py-1 pr-3">Order / AWB</th>
                <th className="py-1 pr-3">Shop</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Payment</th>
                <th className="py-1 pr-3">Updated (IST)</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <tr key={s.id} className="border-t border-cream-100 align-top">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{s.orderNumber}</span>
                    <span className="block font-mono text-xs text-ink-600">
                      {s.awbNumber} · {s.picoOrderId}
                      {s.numBoxes > 1 ? ` · ${s.numBoxes} boxes` : ""}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{s.shopName}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={["LOST", "DAMAGED", "BOOKING_FAILED", "BOOKING_UNCONFIRMED"].includes(s.status) ? "danger" : s.status === "DELIVERED" ? "success" : "info"}>{s.statusLabel}</Badge>
                    {s.partnerName ? <span className="block text-xs text-ink-600">Rider {s.partnerName}</span> : null}
                    {s.lastReason ? <span className="block text-xs text-ink-600">{s.lastReason}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    {s.paymentType === "COD" ? `COD ${paise(s.collectiblePaise)}` : "Prepaid"}
                    <span className="block text-ink-500">Goods {paise(s.goodsTotalPaise)}</span>
                  </td>
                  <td className="py-2 pr-3 text-xs">{istTime(s.updatedAt)}</td>
                  <td className="py-2">
                    <PicoOpsActions orderId={s.orderId} reasons={o.rules.cancelReasons} cancellable={s.status === BOOKING_UNCONFIRMED || picoCancellable(s.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <p className="mb-2 font-semibold text-ink-900">API calls to Pico (latest 40, masked)</p>
          <ul className="space-y-1 text-xs">
            {logs.map((l) => (
              <li key={l.id} className="border-t border-cream-100 pt-1">
                <Badge tone={l.ok === "Y" ? "success" : "danger"}>{l.pxCode ?? (l.httpStatus ? `HTTP ${l.httpStatus}` : "no answer")}</Badge>{" "}
                {l.method} <span className="font-mono">{l.endpoint.split("?")[0]}</span> · {l.latencyMs} ms{l.attempt > 1 ? ` · try ${l.attempt}` : ""} · {istTime(l.createdAt)}
                {l.ok === "N" && (l.responseMessage || l.error) ? <span className="block text-ink-600">{l.responseMessage || l.error}</span> : null}
              </li>
            ))}
            {logs.length === 0 ? <li className="text-ink-600">No calls yet.</li> : null}
          </ul>
        </Card>
        <Card className="p-4">
          <p className="mb-2 font-semibold text-ink-900">Status events received (latest 40)</p>
          <ul className="space-y-1 text-xs">
            {events.map((e) => (
              <li key={e.id} className="border-t border-cream-100 pt-1">
                <span className="font-mono">{e.awbNumber}</span> · {picoStateLabel(e.status)} ({e.status}) · {e.source} · event {istTime(e.eventTs)} · received {istTime(e.receivedAt)}
                {!e.known ? <Badge tone="warning">unknown AWB</Badge> : null}
                {e.reason ? <span className="block text-ink-600">{e.reason}</span> : null}
              </li>
            ))}
            {events.length === 0 ? <li className="text-ink-600">No events yet.</li> : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}
