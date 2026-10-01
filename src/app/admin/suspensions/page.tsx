import { redirect } from "next/navigation";

import { SuspensionOrderActions } from "@/components/suspension-order-actions";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listActiveSuspensions } from "@/server/services/shop-suspension";

export const metadata = { title: "Shop suspensions" };
export const dynamic = "force-dynamic";

const OUTCOME_LABEL: Record<string, string> = {
  CANCELLED: "Cancelled & refunded",
  CONTINUING: "Shop is finishing it",
  AWAITING_REVIEW: "Needs your decision",
  FAILED: "Automatic cancel failed — needs you",
};

/** Active suspensions and what happened to each open order — decide the ones held for review here. */
export default async function SuspensionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_SUSPEND)) redirect("/");
  const suspensions = await listActiveSuspensions();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Shop suspensions"
        description="Open orders are judged by their status when a shop is suspended. Orders held for review wait here for a decision."
      />
      {suspensions.length === 0 ? (
        <EmptyState title="No shops are suspended." />
      ) : (
        suspensions.map(({ suspension, shopName, orders }) => (
          <Card key={suspension.id} className="space-y-3 p-5" data-testid="suspension">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-ink-900">{shopName}</p>
              <span className="text-xs text-ink-500">
                since {suspension.effectiveAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
              </span>
            </div>
            <p className="text-sm text-ink-600">Reason: {suspension.reason}</p>
            <p className="text-sm text-ink-600">Owner was asked to: {suspension.expectedAction}</p>
            {orders.length === 0 ? (
              <p className="text-sm text-ink-500">There were no open orders.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {orders.map((o) => (
                  <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {o.orderNumber} <span className="text-ink-500">· was {o.statusAtSuspension.toLowerCase().replace(/_/g, " ")}, now {o.statusNow.toLowerCase().replace(/_/g, " ")}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={o.outcome === "AWAITING_REVIEW" || o.outcome === "FAILED" ? "warning" : "neutral"}>
                        {OUTCOME_LABEL[o.outcome]}
                      </Badge>
                      {o.outcome === "AWAITING_REVIEW" || o.outcome === "FAILED" ? <SuspensionOrderActions orderId={o.orderId} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
