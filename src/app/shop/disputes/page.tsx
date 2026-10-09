import Link from "next/link";
import { redirect } from "next/navigation";

import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { SHOP_MENUS } from "@/lib/board/menus";
import { pickTab } from "@/lib/board/status-groups";
import { getBoardLang } from "@/server/board-lang";
import { DISPUTE_REASON_LABELS, DISPUTE_STATUS_LABELS, isDisputeTerminal } from "@/lib/dispute-states";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { listDisputesForShopOwner } from "@/server/services/disputes";

export const metadata = { title: "Shop disputes" };
export const dynamic = "force-dynamic";

/** Event layer: disputes customers have raised on the shop's orders — reply, add photos, propose a resolution. */
export default async function ShopDisputesPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [all, lang, query] = await Promise.all([listDisputesForShopOwner(user.id), getBoardLang(), searchParams]);
  const open = all.filter((d) => !isDisputeTerminal(d.status));
  const resolved = all.filter((d) => isDisputeTerminal(d.status));
  const tab = pickTab(query.tab, ["open", "resolved"] as const, open.length > 0 || resolved.length === 0 ? "open" : "resolved");
  const page = paginate(tab === "open" ? open : resolved, query.page, 10);
  const disputes = page.rows;
  const labels = Object.fromEntries((SHOP_MENUS.find((m) => m.key === "disputes")?.items ?? []).map((i) => [i.key, tr(i.label, lang)]));

  return (
    <>
      <PageHeader
        title="Disputes"
        description={`${open.length} open. Reply on each case so our support team has your side — you are told of every update.`}
      />
      <ListTabs
        label="Disputes"
        active={tab}
        tabs={[
          { key: "open", label: labels.open ?? "Open", href: "/shop/disputes?tab=open", count: open.length, urgent: true },
          { key: "resolved", label: labels.resolved ?? "Resolved", href: "/shop/disputes?tab=resolved", count: resolved.length },
        ]}
      />
      {disputes.length === 0 ? (
        <EmptyState
          title={tab === "open" ? "No open disputes." : "No resolved disputes yet."}
          description="Disputes customers raise on your orders appear here."
        />
      ) : (
        <div className="space-y-3">
          {disputes.map((d) => (
            <Card key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <Link href={`/disputes/${d.id}`} className="font-mono font-medium text-ink-900 underline">
                  {d.caseNumber}
                </Link>
                <p className="text-sm text-ink-600">
                  Order {d.orderNumber} · {DISPUTE_REASON_LABELS[d.reason]} · {formatPaise(d.disputedAmountPaise)} ·{" "}
                  {d.createdAt.toLocaleDateString("en-IN")}
                </p>
              </div>
              <Badge tone={isDisputeTerminal(d.status) ? "neutral" : "warning"}>{DISPUTE_STATUS_LABELS[d.status]}</Badge>
            </Card>
          ))}
        </div>
      )}
      <Pager lang={lang} page={page.page} pageCount={page.pageCount} hrefFor={(n) => `/shop/disputes?tab=${tab}&page=${n}`} />
    </>
  );
}
