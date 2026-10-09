import Link from "next/link";

import { KPICard } from "@/components/kpi-card";
import { Alert, Badge, Card, Money, Section } from "@/components/ui";
import type { ShopDashboard } from "@/server/services/dashboards";

/** The shop operator's day at a glance — every number comes from the database (services/dashboards.ts). */
export function ShopDashboardView({ data }: { data: ShopDashboard }) {
  const { orders, revenue, returns, inventory, riders, customerIssues, notifications } = data;
  return (
    <div className="mb-8 space-y-6" data-testid="shop-dashboard">
      {data.shop.ordersPaused && data.shop.status === "APPROVED" ? (
        <Alert tone="warning" title="New orders are paused">
          Customers cannot check out with your shop until you switch orders back on in Location &amp; delivery settings.
        </Alert>
      ) : null}

      <Section title="Today's orders">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KPICard title="Placed today" value={orders.today} color="blue" />
          <KPICard title="Awaiting your acceptance" value={orders.pending} color={orders.pending > 0 ? "orange" : "purple"} />
          <KPICard title="In progress" value={orders.active} color="blue" />
          <KPICard title="Delivered" value={orders.completed} color="green" />
          <KPICard title="Cancelled" value={orders.cancelled} color={orders.cancelled > 0 ? "red" : "purple"} />
        </div>
      </Section>

      <Section title="Revenue today">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KPICard title="Goods delivered" value={<Money paise={revenue.deliveredGoodsPaise} />} subtitle={`${revenue.deliveredOrders} order${revenue.deliveredOrders === 1 ? "" : "s"}`} color="green" />
          <KPICard title="Commission" value={<Money paise={revenue.commissionPaise} />} color="purple" />
          <KPICard title="Payable to you" value={<Money paise={revenue.netPayablePaise} />} subtitle="before the settlement hold" color="green" />
          <KPICard title="Value placed" value={<Money paise={revenue.placedValuePaise} />} subtitle="paid orders placed today" color="blue" />
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Riders" href="/shop/orders" linkLabel="Open orders">
          <Card className="grid grid-cols-2 gap-3 p-4 text-sm">
            <p>Waiting for a rider: <strong>{riders.waitingForRider}</strong></p>
            <p>Offer sent: <strong>{riders.offered}</strong></p>
            <p>Searching: <strong>{riders.searching}</strong></p>
            <p className={riders.searchStopped > 0 ? "text-red-700" : ""}>Search stopped: <strong>{riders.searchStopped}</strong></p>
            <p>Rider assigned: <strong>{riders.assigned}</strong></p>
          </Card>
        </Section>

        <Section title="Returns &amp; customer issues" href="/shop/returns" linkLabel="Returns">
          <Card className="grid grid-cols-2 gap-3 p-4 text-sm">
            <p>Open returns: <strong>{returns.open}</strong></p>
            <p className={returns.awaitingReview > 0 ? "text-amber-700" : ""}>Awaiting your review: <strong>{returns.awaitingReview}</strong></p>
            <p>New returns today: <strong>{returns.newToday}</strong></p>
            <p>Open complaints on your orders: <strong>{customerIssues.openGrievances}</strong></p>
          </Card>
        </Section>
      </div>

      <Section title="Inventory" href="/shop/inventory" linkLabel="Manage stock">
        <Card className="space-y-3 p-4">
          <p className="text-sm text-ink-600">
            {inventory.counts.inStock} in stock · <strong>{inventory.counts.lowStock}</strong> low ·{" "}
            <strong>{inventory.counts.outOfStock}</strong> out of stock · {inventory.counts.reorderRequired} to reorder ·{" "}
            {inventory.openAlerts} open alert{inventory.openAlerts === 1 ? "" : "s"}
          </p>
          {inventory.lowStockProducts.length > 0 ? (
            <ul className="divide-y divide-cream-100 text-sm" data-testid="low-stock-list">
              {inventory.lowStockProducts.map((p) => (
                <li key={p.shopProductId} className="flex items-center justify-between gap-2 py-1.5">
                  <span>{p.name}</span>
                  <span className="flex items-center gap-2 text-ink-500">
                    {p.available} left{p.reserved ? ` (+${p.reserved} reserved)` : ""}
                    <Badge tone={p.status === "OUT_OF_STOCK" ? "danger" : "warning"}>{p.status === "OUT_OF_STOCK" ? "out" : "low"}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-500">Nothing is running low.</p>
          )}
        </Card>
      </Section>

      <Section title={`Notifications${notifications.unread ? ` (${notifications.unread} new)` : ""}`} href="/profile" linkLabel="All notifications">
        <Card className="divide-y divide-cream-100">
          {notifications.recent.length === 0 ? <p className="p-4 text-sm text-ink-500">Nothing yet.</p> : null}
          {notifications.recent.map((n) => (
            <div key={n.id} className="p-3 text-sm">
              <p className={n.read ? "text-ink-700" : "font-semibold text-ink-900"}>{n.title}</p>
              <p className="text-ink-500">{n.body}</p>
            </div>
          ))}
        </Card>
      </Section>
      <p className="text-xs text-ink-500">
        Shop status: <Link href="/shop" className="underline">{data.shop.status.replace(/_/g, " ").toLowerCase()}</Link>
        {data.shop.deliveryAvailable ? " · home delivery on" : " · pickup only"}
      </p>
    </div>
  );
}
