import Link from "next/link";
import { redirect } from "next/navigation";

import { PendingShopChanges } from "@/components/shop/pending-shop-changes";
import { PageHeader, Section } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { listShopChangeRequests } from "@/server/rbac-support/change-requests";
import { toChangeViews } from "@/server/rbac-support/views";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Pending changes" };
export const dynamic = "force-dynamic";

/**
 * RBAC v2 Phase 5 (brief §4.4): changes GoKesari support proposed for the owner's shop, decided item by item,
 * and the history of past decisions. Nothing changes in the shop until the owner approves.
 */
export default async function ShopChangesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await isFeatureEnabled("rbac_v2_shop_change_requests"))) redirect("/shop");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = await activeShop(shops);
  const history = (await searchParams).tab === "history";
  const views = await toChangeViews(await listShopChangeRequests(shop.id, user, { history }));

  return (
    <>
      <PageHeader title="Pending changes for approval" description={`${shop.name} — approve or reject what GoKesari support proposed. Nothing changes until you approve.`} />
      <nav className="mb-3 flex gap-1" aria-label="Pending or history">
        <Link href="/shop/changes" className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ${history ? "bg-cream-100 text-ink-700" : "bg-kesari-600 text-white"}`}>
          Waiting for me
        </Link>
        <Link href="/shop/changes?tab=history" className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ${history ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}>
          History
        </Link>
      </nav>
      <Section title={history ? "Past decisions" : `Waiting for your decision (${views.length})`}>
        <PendingShopChanges requests={views} />
      </Section>
    </>
  );
}
