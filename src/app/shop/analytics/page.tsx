import { redirect } from "next/navigation";

import { KpiDashboard, KpiPeriodPicker } from "@/components/kpi-dashboard";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { defaultWindow, getMarketplaceKpis } from "@/server/services/analytics";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop analytics" };
export const dynamic = "force-dynamic";

/** The shop's own KPIs (GS-069 role-scoped view): fill, speed, cancellations, repeat customers, campaigns. */
export default async function ShopAnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_SHOP)) redirect("/");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];
  const { days: raw } = await searchParams;
  const days = [7, 30, 90].includes(Number(raw)) ? Number(raw) : 30;
  const window = defaultWindow(days);
  const kpis = await getMarketplaceKpis({ ...window, shopId: shop.id });

  return (
    <>
      <PageHeader title="Analytics" description={`${shop.name} — ${window.from} to ${window.to} (end exclusive).`} />
      <KpiPeriodPicker basePath="/shop/analytics" days={days} />
      <KpiDashboard kpis={kpis} />
    </>
  );
}
