import Link from "next/link";

import { Card, Money } from "@/components/ui";
import type { Duration, MarketplaceKpis } from "@/server/services/analytics";

const pct = (value: number | null) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);
const mins = (d: Duration) =>
  d.count === 0 ? "—" : `${d.medianMinutes ?? "—"} min median · ${d.avgMinutes ?? "—"} avg (${d.count})`;

function Tile({ label, value, hint, id }: { label: string; value: React.ReactNode; hint?: React.ReactNode; id?: string }) {
  return (
    <Card className="p-4" data-kpi={id}>
      <p className="text-xs text-ink-500">
        {id ? <span className="mr-1 text-ink-500">{id}</span> : null}
        {label}
      </p>
      <p className="mt-1 text-lg font-bold text-ink-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
    </Card>
  );
}

/** Period links (7 / 30 / 90 days) for a KPI page. */
export function KpiPeriodPicker({ basePath, days }: { basePath: string; days: number }) {
  return (
    <nav className="mb-4 flex gap-2 text-sm">
      {[7, 30, 90].map((d) => (
        <Link
          key={d}
          href={`${basePath}?days=${d}`}
          className={`rounded-lg border px-3 py-1 ${d === days ? "border-kesari-400 bg-kesari-50" : "border-cream-200"}`}
        >
          Last {d} days
        </Link>
      ))}
    </nav>
  );
}

/**
 * The KPI set (GS-069). Rider and shop-retention KPIs are marketplace-only
 * and hidden for a single shop.
 */
export function KpiDashboard({ kpis }: { kpis: MarketplaceKpis }) {
  const maxGmv = Math.max(1, ...kpis.gmvTrend.map((d) => d.gmvPaise));
  const totalGmv = kpis.gmvTrend.reduce((sum, d) => sum + d.gmvPaise, 0);
  return (
    <div className="space-y-6" data-testid="kpi-dashboard">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-700">Orders</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile id="KPI-001" label="GMV delivered" value={<Money paise={totalGmv} />} hint={`${kpis.orders.delivered} delivered of ${kpis.orders.placed} placed`} />
          <Tile id="KPI-002" label="Order fill rate" value={pct(kpis.fillRate)} hint={`Item fill rate ${pct(kpis.itemFillRate)}`} />
          <Tile id="KPI-008" label="Cancellation rate" value={pct(kpis.cancellationRate)} hint={`${kpis.orders.cancelled} cancelled`} />
          <Tile
            id="KPI-009"
            label="Refund rate"
            value={pct(kpis.refundRate)}
            hint={
              <>
                <Money paise={kpis.orders.refundedValuePaise} /> refunded ({pct(kpis.refundValueRate)} of value)
              </>
            }
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-700">Speed</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Tile id="KPI-003" label="Shop acceptance time" value={mins(kpis.shopAcceptance)} />
          <Tile id="KPI-004" label="Pick & pack time" value={mins(kpis.pickPack)} />
          <Tile id="KPI-005" label="Rider assignment time" value={mins(kpis.assignment)} />
          <Tile id="KPI-006" label="Delivery time (pickup → drop)" value={mins(kpis.riderDelivery)} hint={`End to end: ${mins(kpis.endToEnd)}`} />
          <Tile
            id="KPI-007"
            label="On-time delivery"
            value={pct(kpis.onTime.rate)}
            hint={`${kpis.onTime.onTime} of ${kpis.onTime.promised} orders with a promised time`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-700">Customers & growth</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile
            id="KPI-010"
            label="Customer repeat rate"
            value={pct(kpis.customers.repeatRate)}
            hint={`${kpis.customers.repeat} of ${kpis.customers.ordering} ordered twice+ · ${kpis.customers.returning} returning`}
          />
          <Tile
            id="KPI-011"
            label="Subscription retention"
            value={pct(kpis.subscriptions.retention)}
            hint={`${kpis.subscriptions.retained} of ${kpis.subscriptions.liveAtStart} kept · ${kpis.subscriptions.newInWindow} new · ${kpis.subscriptions.cancelledInWindow} cancelled`}
          />
          <Tile
            id="KPI-015"
            label="Marketing conversion"
            value={pct(kpis.marketing.conversionRate)}
            hint={
              <>
                {kpis.marketing.converted} of {kpis.marketing.recipients} reached · {kpis.marketing.opened} opened ·{" "}
                <Money paise={kpis.marketing.revenuePaise} />
              </>
            }
          />
          {kpis.shopRetention ? (
            <Tile
              id="KPI-014"
              label="Shop retention"
              value={pct(kpis.shopRetention.rate)}
              hint={`${kpis.shopRetention.retained} of ${kpis.shopRetention.previousActive} shops active again`}
            />
          ) : null}
        </div>
      </section>

      {kpis.riders ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink-700">Riders</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              id="KPI-012"
              label="Rider acceptance rate"
              value={pct(kpis.riders.acceptanceRate)}
              hint={`${kpis.riders.offersAccepted} accepted · ${kpis.riders.offersDeclined} declined / expired`}
            />
            <Tile
              id="KPI-013"
              label="Rider utilisation"
              value={pct(kpis.riders.utilisation)}
              hint={`${kpis.riders.busyHours} h on deliveries of ${kpis.riders.onlineHours} h online`}
            />
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-700">Delivered GMV by day</h2>
        {kpis.gmvTrend.length === 0 ? (
          <p className="text-sm text-ink-500">No delivered orders in this period.</p>
        ) : (
          <Card className="p-4">
            <ul className="space-y-1 text-xs">
              {kpis.gmvTrend.map((d) => (
                <li key={d.day} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-ink-500">{d.day.slice(5)}</span>
                  <span className="h-2 rounded bg-kesari-400" style={{ width: `${Math.max(2, (d.gmvPaise / maxGmv) * 70)}%` }} />
                  <span className="text-ink-600">
                    <Money paise={d.gmvPaise} /> · {d.orders}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
