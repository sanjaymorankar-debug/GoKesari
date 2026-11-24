import { notFound, redirect } from "next/navigation";

import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listChargebacks, SETTLEMENT_FLAG } from "@/server/payments/settlement";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Chargebacks" };
export const dynamic = "force-dynamic";

const OUTCOME_TONE = { OPEN: "danger", WON: "success", LOST: "warning", CLOSED: "neutral" } as const;
const when = (d: Date | null) => (d ? d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—");

/**
 * Admin → Payments → Chargebacks (PAY-SM, docs/payment-settlement-states-2026-11.md):
 * every dispute / chargeback the gateway reported, open ones first by deadline.
 * Evidence is sent from the gateway's own dashboard; this page shows what is due and when.
 */
export default async function AdminChargebacksPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  if (!(await isFeatureEnabled(SETTLEMENT_FLAG))) notFound();
  const rows = await listChargebacks();
  const now = Date.now();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Chargebacks"
        description="Payments the customer's bank disputed. Send evidence from the gateway's dashboard before the respond-by time; the outcome updates here when the gateway decides."
      />
      {rows.length === 0 ? (
        <EmptyState title="No chargebacks" description="No gateway has reported a dispute." testId="chargebacks-empty" />
      ) : (
        <Card className="overflow-x-auto" data-testid="chargebacks-table">
          <table className="min-w-full text-sm">
            <thead className="bg-cream-50 text-left text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Respond by</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2">Payment</th>
                <th className="px-3 py-2">Gateway dispute</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const overdue = c.outcome === "OPEN" && c.respondBy !== null && c.respondBy.getTime() < now;
                return (
                  <tr key={c.id} className="border-t border-cream-200 align-top" data-testid="chargeback-row">
                    <td className="px-3 py-2">
                      <Badge tone={OUTCOME_TONE[c.outcome]}>{c.outcome}</Badge>
                      <span className="block text-xs text-ink-500">{c.gatewayStatus}</span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatPaise(c.amountPaise)}
                      {c.intentAmountPaise !== null ? <span className="block text-xs text-ink-500">of {formatPaise(c.intentAmountPaise)}</span> : null}
                    </td>
                    <td className={overdue ? "px-3 py-2 font-semibold text-red-700" : "px-3 py-2"}>
                      {when(c.respondBy)}
                      {overdue ? <span className="block text-xs">Past the deadline</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {c.reason ?? "—"}
                      {c.reasonCode ? <span className="block text-xs text-ink-500">code {c.reasonCode}</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {c.description ?? <span className="text-ink-500">Not an online-payment intent</span>}
                      {c.purpose ? <span className="block text-xs text-ink-500">{c.purpose} · {c.referenceId}</span> : null}
                      <span className="block text-xs text-ink-500">{c.gatewayPaymentId ?? c.gatewayOrderId ?? "—"}</span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {c.gateway} · {c.disputeType ?? "dispute"} {c.disputeId}
                      <span className="block text-ink-500">opened {when(c.openedAt)}</span>
                      {c.resolvedAt ? <span className="block text-ink-500">resolved {when(c.resolvedAt)}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
