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
