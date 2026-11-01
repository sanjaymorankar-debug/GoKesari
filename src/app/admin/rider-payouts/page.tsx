import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RunMonthButton, TransferReviewActions } from "@/components/rider-wallet/admin-actions";
import { KIND_LABEL, TRANSFER_STATUS } from "@/components/rider-wallet/labels";
import { Badge, Card, EmptyState, PageHeader, Section } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listRuns } from "@/server/rider-wallet/monthly";
import { monthLabel, previousMonthOf } from "@/server/rider-wallet/rules";
import { listRecentWithdrawals, listTransfersForReview } from "@/server/rider-wallet/views";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Rider payouts" };
export const dynamic = "force-dynamic";

const RUN_TONE = { RUNNING: "info", COMPLETED: "success", COMPLETED_WITH_FAILURES: "warning" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * Admin → Rider payouts (docs/gig-bank-payouts-2026-10): the monthly runs on
 * the 5th (batch id, status, totals, failures), transfers waiting for a
 * decision, and recent withdrawals. Weekly rider batches stay under Finance.
 */
export default async function AdminRiderPayoutsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  if (!(await isFeatureEnabled("rider_bank_account_enabled"))) notFound();
  const canAct = can(user.role, PERMISSIONS.FINANCE_PREPARE);
  const [runs, review, withdrawals, rule, monthlyOn] = await Promise.all([
    listRuns(),
    listTransfersForReview(),
    listRecentWithdrawals(50),
    getRule("riderPayouts"),
    isFeatureEnabled("rider_monthly_payout_enabled"),
  ]);

  return (
    <div className="pb-10">
      <PageHeader
        title="Rider payouts"
        description={`Monthly run on day ${rule.payoutDayOfMonth} from ${String(rule.payoutHourIst).padStart(2, "0")}:00 IST (${monthlyOn ? "on" : "off"}) · provider ${rule.provider} · minimum ${formatPaise(rule.monthlyMinPaise)} · ${rule.maxRetries} retries`}
      />

      <Section title={`Needs a decision (${review.length})`}>
        {review.length === 0 ? (
          <Card className="p-5 text-sm text-ink-500">Nothing waiting.</Card>
        ) : (
          <Card className="divide-y divide-cream-200">
            {review.map((t) => (
              <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="text-sm">
                  <p className="font-medium text-ink-900">
                    {t.partnerName} · {KIND_LABEL[t.kind]} · {formatPaise(t.netPaise)}
                  </p>
                  <p className="text-xs text-ink-500">
                    {when(t.createdAt)} · {t.account} · retries {t.retryCount}
                  </p>
                  <p className="mt-1 text-xs text-red-700">{t.failureReason}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge tone={TRANSFER_STATUS[t.status].tone}>{TRANSFER_STATUS[t.status].label}</Badge>
                  {canAct && t.status === "FAILED" ? <TransferReviewActions transferId={t.id} canRetry /> : null}
                </div>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Monthly runs">
        {user.role === "ADMIN" ? (
          <div className="mb-4">
            <RunMonthButton defaultMonth={previousMonthOf(new Date())} />
          </div>
        ) : null}
        {runs.length === 0 ? (
          <EmptyState title="No monthly run yet" description="The first run pays the month before on the payout day once the flag is on." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-500">
                <tr>
                  <th className="p-3">Month</th>
                  <th className="p-3">Batch</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Paid / riders</th>
                  <th className="p-3 text-right">Failed</th>
                  <th className="p-3 text-right">Carried</th>
                  <th className="p-3 text-right">Gross</th>
                  <th className="p-3 text-right">TDS</th>
                  <th className="p-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="p-3">
                      <Link href={`/admin/rider-payouts/${r.id}`} className="font-medium text-kesari-600 hover:underline">
                        {monthLabel(r.periodMonth)}
                      </Link>
                    </td>
                    <td className="p-3 font-mono text-xs">{r.id.slice(0, 8)}</td>
                    <td className="p-3">
                      <Badge tone={RUN_TONE[r.status]}>{r.status.replaceAll("_", " ").toLowerCase()}</Badge>
                    </td>
                    <td className="p-3 text-right">
                      {r.paid} / {r.eligible}
                    </td>
                    <td className="p-3 text-right">{r.failed}</td>
                    <td className="p-3 text-right">{r.skipped}</td>
                    <td className="p-3 text-right">{formatPaise(r.grossPaise)}</td>
                    <td className="p-3 text-right">{formatPaise(r.tdsPaise)}</td>
                    <td className="p-3 text-right">{formatPaise(r.netPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section title="Recent withdrawals">
        {withdrawals.length === 0 ? (
          <Card className="p-5 text-sm text-ink-500">No withdrawals yet.</Card>
        ) : (
          <Card className="divide-y divide-cream-200">
            {withdrawals.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
                <div>
                  <p className="font-medium text-ink-900">
                    {t.partnerName} · {formatPaise(t.grossPaise)}
                    {t.tdsPaise ? ` (TDS ${formatPaise(t.tdsPaise)})` : ""}
                  </p>
                  <p className="text-xs text-ink-500">
                    {when(t.createdAt)} · {t.account} · {t.mode}
                    {t.utr ? ` · UTR ${t.utr}` : ""}
                  </p>
                </div>
                <Badge tone={TRANSFER_STATUS[t.status].tone}>{TRANSFER_STATUS[t.status].label}</Badge>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}
