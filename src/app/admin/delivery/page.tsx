import { redirect } from "next/navigation";

import { AllocateOrder } from "@/components/delivery-admin";
import { Alert, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { canSeeDelivery } from "@/server/delivery/access";
import { deliveryDashboard, listProviderViews } from "@/server/delivery/admin";
import { listZones } from "@/server/delivery/zones";
import { isFeatureEnabled } from "@/server/services/feature-flags";

import { DeliveryNav, paise } from "./delivery-nav";

export const metadata = { title: "Delivery management" };
export const dynamic = "force-dynamic";

/** Admin → Delivery management → Dashboard (docs/hdms-2026-11). Last 7 days. */
export default async function DeliveryDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!canSeeDelivery(user.role)) redirect("/");
  const [enabled, stats, providers, zones] = await Promise.all([isFeatureEnabled("hdms_enabled", { districtCode: null }), deliveryDashboard(7), listProviderViews(), listZones()]);
  const total = stats.byStatus.reduce((s, r) => s + r.n, 0);
  const count = (statuses: string[]) => stats.byStatus.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.n, 0);
  const tiles: [string, number | string][] = [
    ["Partner bookings (7 days)", total],
    ["Active now", count(["CREATED", "SEARCHING", "ASSIGNED", "AT_PICKUP", "PICKED_UP", "IN_TRANSIT", "RETURNING"])],
    ["Delivered", count(["DELIVERED"])],
    ["Failed / returned", count(["FAILED", "RETURNED"])],
    ["Cancelled", count(["CANCELLED"])],
    ["Partners enabled", providers.filter((p) => p.enabled).length],
    ["Zones suspended", zones.filter((z) => z.status === "SUSPENDED").length],
  ];
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Delivery management" description="Shop riders, GoKesari riders and delivery partners (Shadowfax, Pidge, Porter, Borzo) in one place." />
      <DeliveryNav current="dashboard" />
      {!enabled ? (
        <Alert tone="info">
          The allocation engine is off (feature flag <code>hdms_enabled</code>). Orders go to shop riders and GoKesari riders exactly as before; nothing is booked with a delivery partner. Settings here can be prepared in the meantime.
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, value]) => (
          <Card key={label} className="p-3">
            <p className="text-xs text-ink-500">{label}</p>
            <p className="text-xl font-semibold text-ink-900">{value}</p>
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">By delivery partner (7 days)</h2>
        {stats.byProvider.length === 0 ? (
          <p className="text-sm text-ink-500">No partner bookings yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-ink-500">
                <tr>
                  <th className="py-1 pr-3">Partner</th>
                  <th className="pr-3">Bookings</th>
                  <th className="pr-3">Delivered</th>
                  <th className="pr-3">Failed</th>
                  <th className="pr-3">Success rate</th>
                  <th className="pr-3">Avg minutes</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.byProvider.map((r) => (
                  <tr key={r.provider ?? "-"} className="border-t border-cream-100">
                    <td className="py-1 pr-3">{r.provider ?? "—"}</td>
                    <td className="pr-3">{r.n}</td>
                    <td className="pr-3">{r.delivered}</td>
                    <td className="pr-3">{r.failed}</td>
                    <td className="pr-3">{r.n ? `${Math.round((r.delivered / r.n) * 100)}%` : "—"}</td>
                    <td className="pr-3">{r.avgMinutes ? Math.round(r.avgMinutes) : "—"}</td>
                    <td>{paise(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">Allocation decisions (7 days)</h2>
        {stats.runs.length === 0 ? (
          <p className="text-sm text-ink-500">None yet.</p>
        ) : (
          <ul className="text-sm">
            {stats.runs.map((r) => (
              <li key={`${r.outcome}-${r.channel}`}>
                {r.outcome}
                {r.channel ? ` · ${r.channel}` : ""}: {r.n}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-4">
        <h2 className="mb-2 text-base font-semibold">Allocate an order now</h2>
        <p className="mb-2 text-sm text-ink-500">Runs the engine for one ready order: shop rider → GoKesari rider → delivery partner, in the order set in Allocation rules.</p>
        <AllocateOrder />
      </Card>
    </div>
  );
}
