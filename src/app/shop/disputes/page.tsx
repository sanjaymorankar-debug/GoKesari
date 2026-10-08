import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { DISPUTE_REASON_LABELS, DISPUTE_STATUS_LABELS, isDisputeTerminal } from "@/lib/dispute-states";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { listDisputesForShopOwner } from "@/server/services/disputes";

export const metadata = { title: "Shop disputes" };
export const dynamic = "force-dynamic";

/** Event layer: disputes customers have raised on the shop's orders — reply, add photos, propose a resolution. */
export default async function ShopDisputesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const disputes = await listDisputesForShopOwner(user.id);
  const open = disputes.filter((d) => !isDisputeTerminal(d.status));

  return (
    <>
      <PageHeader
        title="Disputes"
        description={`${open.length} open. Reply on each case so our support team has your side — you are told of every update.`}
      />
      {disputes.length === 0 ? (
        <EmptyState title="No disputes." description="Disputes customers raise on your orders appear here." />
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
    </>
  );
}
