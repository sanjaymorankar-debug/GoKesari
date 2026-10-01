import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge, Card, EmptyState, LinkButton, Money, PageHeader } from "@/components/ui";
import { RETURN_STATUS_LABELS, type ReturnStatus } from "@/lib/return-states";
import { getCurrentUser } from "@/server/authz/guards";
import { listReturnsForUser } from "@/server/services/returns";

export const metadata = { title: "My returns" };
export const dynamic = "force-dynamic";

export default async function MyReturnsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const returns = await listReturnsForUser(user.id);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="My returns"
        description="Track your return requests, pickups and refunds."
        action={<LinkButton href="/orders" variant="secondary">My orders</LinkButton>}
      />
      {returns.length === 0 ? (
        <EmptyState title="No returns yet" description="You can request a return from a delivered order." />
      ) : (
        <div className="space-y-3">
          {returns.map((r) => (
            <Link key={r.id} href={`/returns/${r.id}`} className="block">
              <Card className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-cream-50" data-testid="return-row">
                <div>
                  <p className="font-medium text-ink-900">
                    {r.returnNumber} <span className="text-sm text-ink-500">· order {r.orderNumber}</span>
                  </p>
                  <p className="text-xs text-ink-500">
                    {r.shopName} · {r.itemCount} item{r.itemCount === 1 ? "" : "s"} ·{" "}
                    {new Date(r.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={r.status === "REFUND_COMPLETED" ? "success" : r.status === "REJECTED" ? "danger" : "info"}>
                    {RETURN_STATUS_LABELS[r.status as ReturnStatus]}
                  </Badge>
                  <Money paise={r.refundedPaise ?? r.refundAmountPaise} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
