import { redirect } from "next/navigation";

import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { ReturnCase } from "@/components/return-case";
import { EmptyState, PageHeader } from "@/components/ui";
import { tr, UI } from "@/lib/board/i18n";
import { SHOP_MENUS } from "@/lib/board/menus";
import { pickTab, RETURN_PICKUP_STATUSES, RETURN_REQUEST_STATUSES } from "@/lib/board/status-groups";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getReturnDetail, listReturnsForShop } from "@/server/services/returns";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Shop returns" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 5;
const TABS = ["requests", "pickups", "all"] as const;

/** The shop's return queue: review, approve, receive, inspect and refund — tabbed like the board's Returns submenus. */
export default async function ShopReturnsPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) redirect("/shop");
  const shop = shops[0];

  const [list, lang, query] = await Promise.all([listReturnsForShop(shop.id), getBoardLang(), searchParams]);
  const inTab = (tab: (typeof TABS)[number], status: string) =>
    tab === "requests" ? RETURN_REQUEST_STATUSES.includes(status) : tab === "pickups" ? RETURN_PICKUP_STATUSES.includes(status) : true;
  const requests = list.filter((r) => inTab("requests", r.status)).length;
  const pickups = list.filter((r) => inTab("pickups", r.status)).length;
  const tab = pickTab(query.tab, TABS, requests > 0 ? "requests" : pickups > 0 ? "pickups" : "all");
  // Open work first: anything not finished.
  const finished = ["REJECTED", "REFUND_COMPLETED", "RETURN_CANCELLED"];
  const ordered = list.filter((r) => inTab(tab, r.status)).sort((a, b) => Number(finished.includes(a.status)) - Number(finished.includes(b.status)));
  const page = paginate(ordered, query.page, PAGE_SIZE);
  const details = await Promise.all(page.rows.map((r) => getReturnDetail(r.id, user)));
  const labels = Object.fromEntries((SHOP_MENUS.find((m) => m.key === "returns")?.items ?? []).map((i) => [i.key, tr(i.label, lang)]));

  return (
    <>
      <PageHeader title="Returns" description={`${shop.name} — customer return requests.`} />
      <ListTabs
        label="Returns"
        active={tab}
        tabs={[
          { key: "requests", label: labels.requests ?? "Requests", href: "/shop/returns?tab=requests", count: requests, urgent: true },
          { key: "pickups", label: labels.pickups ?? "Pickups", href: "/shop/returns?tab=pickups", count: pickups },
          { key: "all", label: tr(UI.all, lang), href: "/shop/returns?tab=all" },
        ]}
      />
      {details.length === 0 ? (
        <EmptyState title={list.length === 0 ? "No returns." : "Nothing here right now."} description="Customer return requests appear here." />
      ) : (
        <div className="space-y-4">
          {details.map((detail) => (
            <ReturnCase key={detail.ret.id} detail={detail} />
          ))}
        </div>
      )}
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/shop/returns?tab=${tab}&page=${n}`} />
    </>
  );
}
