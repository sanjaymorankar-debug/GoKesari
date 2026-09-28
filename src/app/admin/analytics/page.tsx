import { redirect } from "next/navigation";

import { KpiDashboard, KpiPeriodPicker } from "@/components/kpi-dashboard";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { defaultWindow, getMarketplaceKpis } from "@/server/services/analytics";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

/** Marketplace KPI dashboard (GS-069, NAV-018) — operators and admins. */
export default async function AdminAnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_ALL) && !can(user.role, PERMISSIONS.REPORT_VIEW_OPERATIONAL)) redirect("/");
  const { days: raw } = await searchParams;
  const days = [7, 30, 90].includes(Number(raw)) ? Number(raw) : 30;
  const window = defaultWindow(days);
  const kpis = await getMarketplaceKpis(window);

  return (
    <>
      <PageHeader title="Analytics" description={`Marketplace KPIs from ${window.from} to ${window.to} (end exclusive).`} />
      <KpiPeriodPicker basePath="/admin/analytics" days={days} />
      <KpiDashboard kpis={kpis} />
    </>
  );
}
