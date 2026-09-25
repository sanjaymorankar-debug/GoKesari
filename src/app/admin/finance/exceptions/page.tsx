import Link from "next/link";
import { redirect } from "next/navigation";

import { ResolveRecordButton } from "@/components/finance-actions";
import { Alert, Card, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listFinancialExceptions } from "@/server/services/finance";

export const metadata = { title: "Financial exceptions" };
export const dynamic = "force-dynamic";

/**
 * Financial exception queue (Part K/O). Operators (FINANCE_EXCEPTIONS_VIEW)
 * see operational problems only — payments, refunds, order/payment
 * mismatches, rider earnings; admins additionally see settlement and payout
 * failures and orders that should have been settled by now.
 */
export default async function FinanceExceptionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const isAdmin = can(user.role, PERMISSIONS.FINANCE_VIEW);
  if (!isAdmin && !can(user.role, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW)) redirect("/");

  const x = await listFinancialExceptions(isAdmin ? "admin" : "operator");
  const empty = (list: unknown[]) => list.length === 0;

  return (
    <>
      <PageHeader
        title="Financial exceptions"
        description="Payments, refunds and mismatches that need someone to look at them."
      />
      {isAdmin ? (
        <p className="-mt-4 mb-6 text-sm">
          <Link href="/admin/finance" className="font-medium text-kesari-700 underline">
            ← Finance console
          </Link>
        </p>
      ) : null}

      <Section title={`Reconciliation items (${x.reconciliation.length})`}>
        {empty(x.reconciliation) ? (
          <Alert tone="success">No open reconciliation items.</Alert>
        ) : (
          <Card className="divide-y divide-cream-100" data-testid="exception-reconciliation">
            {x.reconciliation.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">
                    {r.entityType.toLowerCase()} · {r.checkType.replace(/_/g, " ").toLowerCase()} · {r.reference}
                  </p>
                  <p className="text-xs text-ink-500">
                    {r.detail}
                    {r.expectedPaise != null
                      ? ` Expected ₹${(r.expectedPaise / 100).toFixed(2)}, found ₹${((r.actualPaise ?? 0) / 100).toFixed(2)}.`
                      : ""}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <ResolveRecordButton id={r.id} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title={`Orders needing a refund or decision (${x.refundAttention.length})`}>
        {empty(x.refundAttention) ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <Card className="divide-y divide-cream-100">
            {x.refundAttention.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>{o.orderNumber}</span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={o.status} />
                  <Money paise={o.totalPaise} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Payments">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <p className="mb-2 text-sm font-semibold">Failed (last 14 days)</p>
            {empty(x.failedPayments) ? (
              <p className="text-sm text-ink-500">None.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {x.failedPayments.map((p) => (
                  <li key={p.id} className="flex justify-between gap-2 py-1.5">
                    <span>
                      {p.reference}
                      {p.reason ? <span className="text-xs text-ink-500"> — {p.reason}</span> : null}
                    </span>
                    <Money paise={p.amountPaise} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-4">
            <p className="mb-2 text-sm font-semibold">Pending over 30 minutes</p>
            {empty(x.pendingPayments) ? (
              <p className="text-sm text-ink-500">None.</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {x.pendingPayments.map((p) => (
                  <li key={p.id} className="flex justify-between gap-2 py-1.5">
                    <span>{p.reference}</span>
                    <Money paise={p.amountPaise} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Section>

      <Section title="Recently cancelled / refunded orders">
        {empty(x.recentCancellations) ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <Card className="divide-y divide-cream-100">
            {x.recentCancellations.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {o.orderNumber}
                  {o.reason ? <span className="text-xs text-ink-500"> — {o.reason}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={o.status} />
                  refunded <Money paise={o.refundedPaise} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Delivery / rider adjustments (last 14 days)">
        {empty(x.deliveryAdjustments) ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <Card className="divide-y divide-cream-100">
            {x.deliveryAdjustments.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  {a.type.replace(/_/g, " ").toLowerCase()}
                  {a.orderNumber ? ` · ${a.orderNumber}` : ""} — {a.reason}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  <Money paise={a.amountPaise} />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {x.batchProblems ? (
        <Section title="Settlements & payouts">
          <div className="grid gap-3 lg:grid-cols-3">
            <Card className="p-4">
              <p className="mb-2 text-sm font-semibold">Failed / reversed settlements</p>
              {empty(x.batchProblems.settlements) ? (
                <p className="text-sm text-ink-500">None.</p>
              ) : (
                <ul className="divide-y divide-cream-100 text-sm">
                  {x.batchProblems.settlements.map(({ settlement: s, shopName }) => (
                    <li key={s.id} className="py-1.5">
                      {shopName} · <StatusBadge status={s.status} /> · <Money paise={s.netPayablePaise} />
                      {s.failureReason ? <span className="text-xs text-ink-500"> — {s.failureReason}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-4">
              <p className="mb-2 text-sm font-semibold">Failed / reversed rider payouts</p>
              {empty(x.batchProblems.payouts) ? (
                <p className="text-sm text-ink-500">None.</p>
              ) : (
                <ul className="divide-y divide-cream-100 text-sm">
                  {x.batchProblems.payouts.map(({ payout: p, partnerName }) => (
                    <li key={p.id} className="py-1.5">
                      {partnerName} · <StatusBadge status={p.status} /> · <Money paise={p.amountPaise} />
                      {p.failureReason ? <span className="text-xs text-ink-500"> — {p.failureReason}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card className="p-4">
              <p className="mb-2 text-sm font-semibold">Delivered 9+ days ago, not settled</p>
              {empty(x.batchProblems.unsettled) ? (
                <p className="text-sm text-ink-500">None.</p>
              ) : (
                <ul className="divide-y divide-cream-100 text-sm">
                  {x.batchProblems.unsettled.map((u) => (
                    <li key={u.orderId} className="py-1.5">
                      <Link href={`/admin/finance?trace=${encodeURIComponent(u.orderNumber)}`} className="underline">
                        {u.orderNumber}
                      </Link>{" "}
                      · {u.shopName}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </Section>
      ) : null}
    </>
  );
}
