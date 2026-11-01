import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { KIND_LABEL, TRANSFER_STATUS } from "@/components/rider-wallet/labels";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { isUuid } from "@/server/payouts/http";
import { getTransferStatement } from "@/server/rider-wallet/views";

export const metadata = { title: "Payout statement" };
export const dynamic = "force-dynamic";

/** One payment's summary for the rider who received it (docs/gig-bank-payouts-2026-10). */
export default async function RiderPayoutStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const statement = await getTransferStatement(id, user.id).catch(() => null);
  if (!statement) notFound();
  const { transfer: t, payout } = statement;
  const status = TRANSFER_STATUS[t.status];
  const rows: [string, string][] = [
    ["Earnings in this payment", payout ? `${formatPaise(payout.earningsPaise)} (${payout.earningsCount} deliveries)` : "—"],
    ["Adjustments and carried forward", payout ? formatPaise(payout.adjustmentsPaise) : "—"],
    ["Amount", formatPaise(t.grossPaise)],
    [`TDS${t.tdsRateBp ? ` (${t.tdsRateBp / 100}%, s.194C)` : ""}`, t.tdsPaise ? `− ${formatPaise(t.tdsPaise)}` : "None"],
    ["Fee", t.feePaise ? `− ${formatPaise(t.feePaise)}` : "None"],
    ["Paid to your bank", formatPaise(t.netPaise)],
  ];
  return (
    <div className="mx-auto max-w-2xl pb-10">
      <PageHeader
        title={`${KIND_LABEL[t.kind]} statement`}
        description={new Date(t.createdAt).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Kolkata" })}
        action={
          <Link href="/gig/wallet" className="text-sm font-medium text-kesari-600 hover:underline">
            ← My wallet
          </Link>
        }
      />
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-600">{statement.partnerName}</p>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-500">{label}</dt>
              <dd className="text-right text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>
        <dl className="grid grid-cols-2 gap-y-2 border-t border-cream-200 pt-4 text-sm">
          <dt className="text-ink-500">Account</dt>
          <dd className="text-right">{t.account}</dd>
          <dt className="text-ink-500">Sent by</dt>
          <dd className="text-right">{t.mode}</dd>
          <dt className="text-ink-500">Bank reference (UTR)</dt>
          <dd className="text-right font-mono">{t.utr ?? "—"}</dd>
          {payout ? (
            <>
              <dt className="text-ink-500">Earnings period</dt>
              <dd className="text-right">
                {payout.periodStart} – {payout.periodEnd}
              </dd>
            </>
          ) : null}
        </dl>
        {t.failureReason && t.status !== "SUCCESS" ? <p className="text-sm text-red-700">{t.failureReason}</p> : null}
        <p className="text-xs text-ink-500">Keep this for your records. TDS deducted is deposited against your PAN and shows in your Form 26AS.</p>
      </Card>
    </div>
  );
}
