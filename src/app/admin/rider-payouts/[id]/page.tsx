import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TransferReviewActions } from "@/components/rider-wallet/admin-actions";
import { TRANSFER_STATUS } from "@/components/rider-wallet/labels";
import { Badge, Card, PageHeader, Section } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { getRun, type SkippedRider } from "@/server/rider-wallet/monthly";
import { monthLabel } from "@/server/rider-wallet/rules";
import { runTransferViews } from "@/server/rider-wallet/views";

export const metadata = { title: "Rider payout run" };
export const dynamic = "force-dynamic";

const SKIP_LABEL: Record<SkippedRider["reason"], string> = {
  KYC_INCOMPLETE: "Not approved (KYC)",
  BANK_NOT_VERIFIED: "No verified bank account",
  BELOW_MINIMUM: "Below the minimum",
  NOTHING_DUE: "Nothing due",
};

/** One monthly run: every rider's payment and who was carried forward (docs/gig-bank-payouts-2026-10). */
export default async function AdminRiderPayoutRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const data = await getRun(id).catch(() => null);
  if (!data) notFound();
  const { run } = data;
  const transfers = await runTransferViews(data.transfers);
  const skipped = ((run.summary as { skipped?: SkippedRider[] }).skipped ?? []).filter((s) => s.reason !== "NOTHING_DUE");
  const canAct = can(user.role, PERMISSIONS.FINANCE_PREPARE);

  return (
    <div className="pb-10">
      <PageHeader
        title={`Rider payout — ${monthLabel(run.periodMonth)}`}
        description={`Batch ${run.id} · started ${run.startedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}${run.runs > 1 ? ` · resumed ${run.runs - 1}×` : ""}`}
        action={
          <Link href="/admin/rider-payouts" className="text-sm font-medium text-kesari-600 hover:underline">
            ← Rider payouts
          </Link>
        }
      />
      <Card className="mb-8 grid gap-4 p-5 text-sm sm:grid-cols-4">
        <div>
          <p className="text-ink-500">Paid</p>
          <p className="text-xl font-semibold">
            {run.paid} / {run.eligible}
          </p>
        </div>
        <div>
          <p className="text-ink-500">Failed</p>
          <p className="text-xl font-semibold">{run.failed}</p>
        </div>
        <div>
          <p className="text-ink-500">Gross / TDS</p>
          <p className="text-xl font-semibold">
            {formatPaise(run.grossPaise)} / {formatPaise(run.tdsPaise)}
          </p>
        </div>
        <div>
          <p className="text-ink-500">Net to banks</p>
          <p className="text-xl font-semibold">{formatPaise(run.netPaise)}</p>
        </div>
      </Card>

      <Section title={`Payments (${transfers.length})`}>
        <Card className="divide-y divide-cream-200">
          {transfers.map((t) => (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium text-ink-900">
                  {t.partnerName} · {formatPaise(t.netPaise)} <span className="text-ink-500">(gross {formatPaise(t.grossPaise)}, TDS {formatPaise(t.tdsPaise)})</span>
                </p>
                <p className="text-xs text-ink-500">
                  {t.account} · {t.mode} · retries {t.retryCount}
                  {t.utr ? ` · UTR ${t.utr}` : ""}
                </p>
                {t.failureReason && t.status !== "SUCCESS" ? <p className="mt-1 text-xs text-red-700">{t.failureReason}</p> : null}
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge tone={TRANSFER_STATUS[t.status].tone}>{t.needsReview ? "Needs a decision" : TRANSFER_STATUS[t.status].label}</Badge>
                {canAct && t.status === "FAILED" && t.needsReview ? <TransferReviewActions transferId={t.id} canRetry /> : null}
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Section title={`Carried forward (${skipped.length})`}>
        {skipped.length === 0 ? (
          <Card className="p-5 text-sm text-ink-500">Nobody.</Card>
        ) : (
          <Card className="divide-y divide-cream-200">
            {skipped.map((s) => (
              <div key={s.deliveryPartnerId} className="flex items-center justify-between p-4 text-sm">
                <span>{s.name}</span>
                <span className="text-ink-500">
                  {SKIP_LABEL[s.reason]}
                  {s.amountPaise ? ` · ${formatPaise(s.amountPaise)}` : ""}
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}
