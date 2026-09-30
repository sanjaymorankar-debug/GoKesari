import { redirect } from "next/navigation";

import { AnalyticsChart } from "@/components/analytics-chart";
import { KPICard } from "@/components/kpi-card";
import { LinkButton, Money, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import {
  defaultWindow,
  getLiveOperations,
  getMarketplaceKpis,
  type InFlightOrderStatus,
} from "@/server/services/analytics";
import { ORDER_STATUS_LABELS } from "@/server/services/orders";
import { countOpenRiskFlags } from "@/server/services/risk";
import { countShopsByStatus } from "@/server/services/shops";
import { getAdminDashboard } from "@/server/services/dashboards";

export const metadata = { title: "Admin Dashboard" };
export const dynamic = "force-dynamic";

const pct = (value: number | null) => (value == null ? "—" : `${(value * 100).toFixed(1)}%`);

export default async function AdminDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_ALL) && !can(user.role, PERMISSIONS.REPORT_VIEW_OPERATIONAL)) redirect("/");

  const canViewOrders = can(user.role, PERMISSIONS.ORDER_VIEW_ANY);
  const canApproveShops = can(user.role, PERMISSIONS.SHOP_APPROVE);
  const canReviewRisk = can(user.role, PERMISSIONS.RISK_REVIEW);
  const canViewFinanceExceptions =
    can(user.role, PERMISSIONS.FINANCE_VIEW) || can(user.role, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW);

  const today = defaultWindow(1);
  const [kpis, live, shopCounts, riskCounts] = await Promise.all([
    getMarketplaceKpis(today),
    getLiveOperations(),
    countShopsByStatus(),
    canReviewRisk ? countOpenRiskFlags() : Promise.resolve(null),
  ]);

  const deliveredGmvPaise = kpis.gmvTrend.reduce((sum, d) => sum + d.gmvPaise, 0);
  const deliveredOrders = kpis.gmvTrend.reduce((sum, d) => sum + d.orders, 0);
  const averageOrderPaise =
    kpis.orders.placed > 0 ? Math.round(kpis.orders.placedValuePaise / kpis.orders.placed) : null;

  const inFlightTotal = live.inFlight.reduce((sum, s) => sum + s.count, 0);
  const inFlightCount = (status: InFlightOrderStatus) =>
    live.inFlight.find((s) => s.status === status)?.count ?? 0;
  const awaitingPickup = inFlightCount("READY") + inFlightCount("ASSIGNED");
  const deliveryFailed = inFlightCount("FAILED");
  const inFlightData = live.inFlight.map((s) => ({
    label: ORDER_STATUS_LABELS[s.status],
    value: s.count,
    percentage: inFlightTotal > 0 ? Math.round((s.count / inFlightTotal) * 100) : undefined,
    href: canViewOrders ? `/admin/orders?status=${s.status}` : undefined,
  }));

  const ops = await getAdminDashboard();
  const pendingShops = shopCounts.PENDING_APPROVAL ?? 0;
  const openRiskTotal = riskCounts ? riskCounts.HIGH + riskCounts.MEDIUM + riskCounts.LOW : 0;

  return (
    <div className="space-y-8 pb-10">
      <PageHeader
        title="Admin Dashboard"
        description={`Today's marketplace figures (${today.from}) and live operations.`}
        action={
          <LinkButton href="/admin/analytics" variant="secondary">
            Full analytics
          </LinkButton>
        }
      />

      <Section title="Today">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <KPICard
            title="Orders placed"
            value={kpis.orders.placed}
            subtitle={`${kpis.orders.cancelled} cancelled · ${kpis.orders.refunded} refunded`}
            color="blue"
          />
          <KPICard
            title="Placed order value"
            value={<Money paise={kpis.orders.placedValuePaise} />}
            subtitle={
              averageOrderPaise != null ? (
                <>
                  Average <Money paise={averageOrderPaise} /> per order
                </>
              ) : (
                "No orders placed yet"
              )
            }
            color="purple"
          />
          <KPICard
            title="GMV delivered"
            value={<Money paise={deliveredGmvPaise} />}
            subtitle={`${deliveredOrders} orders delivered`}
            color="green"
          />
          <KPICard
            title="Fill rate"
            value={pct(kpis.fillRate)}
            subtitle={`${kpis.orders.delivered} of ${kpis.orders.placed} placed today delivered so far`}
            color="orange"
          />
        </div>
      </Section>

      <Section
        title="Live operations"
        href={canViewOrders ? "/admin/orders" : undefined}
        linkLabel="Order monitoring"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <KPICard
            title="Orders in flight"
            value={inFlightTotal}
            subtitle={`${inFlightCount("CONFIRMED")} awaiting shop · ${awaitingPickup} packed, awaiting pickup · ${deliveryFailed} delivery failed`}
            color={deliveryFailed > 0 ? "orange" : "blue"}
          />
          <KPICard
            title="Riders online"
            value={live.ridersOnline}
            subtitle={`${live.ridersBusy} on an offer or delivery · ${Math.max(0, live.ridersOnline - live.ridersBusy)} free`}
            color="green"
          />
          <KPICard
            title="Shops awaiting approval"
            value={pendingShops}
            color={pendingShops > 0 ? "orange" : "purple"}
          />
          {riskCounts ? (
            <KPICard
              title="Open risk flags"
              value={openRiskTotal}
              subtitle={`${riskCounts.HIGH} high · ${riskCounts.MEDIUM} medium · ${riskCounts.LOW} low`}
              color={riskCounts.HIGH > 0 ? "red" : "purple"}
            />
          ) : null}
        </div>

        <AnalyticsChart
          title="Orders in flight by status"
          data={inFlightData}
          type="bar"
          color="blue"
        />
      </Section>

      <Section title="Exceptions &amp; risk" href={canViewOrders ? "/admin/exceptions" : undefined} linkLabel="Exceptions queue">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="admin-exceptions">
          <KPICard
            title="Operational exceptions"
            value={ops.exceptions.total}
            subtitle={`${ops.exceptions.critical} critical${ops.exceptions.dispatchSweepLooksDown ? " · dispatch sweep looks down" : ""}`}
            color={ops.exceptions.critical > 0 || ops.exceptions.dispatchSweepLooksDown ? "red" : "purple"}
          />
          <KPICard title="Rider searches stopped today" value={ops.riders.searchesStoppedToday} subtitle="no rider found" color={ops.riders.searchesStoppedToday > 0 ? "orange" : "purple"} />
          <KPICard title="Inventory exceptions" value={ops.inventory.openOutOfStock} subtitle={`out of stock in ${ops.inventory.shopsWithOutOfStock} shop(s) · ${ops.inventory.openLowStock} low/reorder`} color={ops.inventory.openOutOfStock > 0 ? "orange" : "purple"} />
          <KPICard title="Open risk flags" value={ops.risk.open} subtitle={`${ops.risk.high} high`} color={ops.risk.high > 0 ? "red" : "purple"} />
        </div>
      </Section>

      <Section title="Shops, riders, returns &amp; refunds">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="admin-marketplace">
          <KPICard
            title="Shops"
            value={ops.shops.byStatus.APPROVED ?? 0}
            subtitle={`approved · ${ops.shops.byStatus.PENDING_APPROVAL ?? 0} pending · ${ops.shops.byStatus.SUSPENDED ?? 0} suspended`}
            color="green"
          />
          <KPICard title="Riders" value={ops.riders.online} subtitle={`online · ${ops.riders.busy} busy · ${ops.riders.pendingApproval} awaiting approval`} color="green" />
          <KPICard
            title="Returns open"
            value={ops.returns.open}
            subtitle={`${ops.returns.awaitingReview} to review · ${ops.returns.awaitingPickup} in pickup · ${ops.returns.awaitingRefund} awaiting refund`}
            color={ops.returns.awaitingRefund > 0 ? "orange" : "blue"}
          />
          <KPICard
            title="Refunded today"
            value={<Money paise={ops.refunds.refundedValueTodayPaise + ops.refunds.returnRefundsTodayPaise} />}
            subtitle={`${ops.refunds.ordersRefundedToday} order refund(s) · ₹${(ops.refunds.returnRefundsTodayPaise / 100).toFixed(0)} through returns`}
            color="purple"
          />
        </div>
        {ops.shops.suspended.length > 0 ? (
          <div className="mt-4 rounded-xl border border-cream-200 bg-white p-4 text-sm" data-testid="admin-suspended-shops">
            <p className="mb-2 font-medium text-ink-900">
              Suspended shops ({ops.shops.suspended.length}) — <a href="/admin/suspensions" className="text-kesari-700 underline">review orders</a>
            </p>
            <ul className="space-y-1 text-ink-600">
              {ops.shops.suspended.map((s) => (
                <li key={s.shopName + String(s.since)}>
                  {s.shopName} — {s.reason}
                  {s.awaitingReview > 0 ? <span className="ml-2 font-medium text-amber-700">{s.awaitingReview} order(s) need a decision</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title="Catalogue governance">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <KPICard title="MRP corrections to decide" value={ops.catalogue.mrpCorrectionsPending} color={ops.catalogue.mrpCorrectionsPending > 0 ? "orange" : "purple"} />
          <KPICard title="Prices above MRP" value={ops.catalogue.pricesAboveMrp} color={ops.catalogue.pricesAboveMrp > 0 ? "red" : "purple"} />
          <KPICard title="Products with unverified MRP" value={ops.catalogue.mrpUnverified} color="purple" />
          <KPICard title="Reference prices to verify" value={ops.catalogue.referencesToVerify} color="purple" />
        </div>
      </Section>

      <Section title="Notifications &amp; sign-in activity (last 24 hours)">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4" data-testid="admin-platform-health">
          <KPICard
            title="Notification failures"
            value={ops.notifications.failed + ops.notifications.dead}
            subtitle={`${ops.notifications.sent} sent · ${ops.notifications.pending} queued · ${ops.notifications.dead} gave up · ${ops.notifications.skipped} skipped`}
            color={ops.notifications.dead > 0 ? "red" : ops.notifications.failed > 0 ? "orange" : "green"}
          />
          <KPICard title="Sign-in codes requested" value={ops.auth.otpRequested} subtitle={`${ops.auth.otpVerified} signed in`} color="blue" />
          <KPICard title="Failed code attempts" value={ops.auth.otpFailed} color={ops.auth.otpFailed > 20 ? "orange" : "purple"} />
          <KPICard title="Blocked code requests" value={ops.auth.otpBlocked} subtitle="cooldown or limit hit" color={ops.auth.otpBlocked > 10 ? "orange" : "purple"} />
        </div>
      </Section>

      <Section title="Key indicators (today)">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KPICard title="Fill rate" value={pct(ops.kpis.fillRate)} color="green" />
          <KPICard title="On-time delivery" value={pct(ops.kpis.onTimeRate)} color="green" />
          <KPICard title="Cancellation rate" value={pct(ops.kpis.cancellationRate)} color="purple" />
          <KPICard title="Refund rate" value={pct(ops.kpis.refundRate)} color="purple" />
          <KPICard title="Repeat customers" value={pct(ops.kpis.repeatRate)} color="blue" />
        </div>
      </Section>

      <Section title="Operations">
        <div className="flex flex-wrap gap-3">
          {canApproveShops ? <LinkButton href="/admin">Review pending shops</LinkButton> : null}
          {canViewOrders ? (
            <LinkButton href="/admin/orders" variant="secondary">
              Monitor orders
            </LinkButton>
          ) : null}
          {canViewFinanceExceptions ? (
            <LinkButton href="/admin/finance/exceptions" variant="secondary">
              Financial exceptions
            </LinkButton>
          ) : null}
          {canReviewRisk ? (
            <LinkButton href="/admin/risk" variant="secondary">
              Risk review
            </LinkButton>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
