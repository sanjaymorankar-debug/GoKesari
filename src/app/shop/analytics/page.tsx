import { redirect } from "next/navigation";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";

import { KpiDashboard, KpiPeriodPicker } from "@/components/kpi-dashboard";
import { PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { defaultWindow, getMarketplaceKpis } from "@/server/services/analytics";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop analytics" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Analytics", "विश्लेषण", "विश्लेषण"),
  description: L("{shop} — {from} to {to} (end exclusive).", "{shop} — {from} से {to} तक (अंतिम दिन छोड़कर)।", "{shop} — {from} ते {to} (शेवटचा दिवस वगळून)."),
} as const;

/** The shop's own KPIs (GS-069 role-scoped view): fill, speed, cancellations, repeat customers, campaigns. */
export default async function ShopAnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.REPORT_VIEW_SHOP)) redirect("/");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const { days: raw } = await searchParams;
  const days = [7, 30, 90].includes(Number(raw)) ? Number(raw) : 30;
  const window = defaultWindow(days);
  const [kpis, lang] = await Promise.all([getMarketplaceKpis({ ...window, shopId: shop.id }), getBoardLang()]);

  return (
    <>
      <PageHeader title={tr(T.title, lang)} description={tr(T.description, lang).replace("{shop}", shop.name).replace("{from}", window.from).replace("{to}", window.to)} />
      <KpiPeriodPicker basePath="/shop/analytics" days={days} />
      <KpiDashboard kpis={kpis} />
    </>
  );
}
