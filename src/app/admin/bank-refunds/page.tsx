import Link from "next/link";
import { redirect } from "next/navigation";

import { BankRefundQueue } from "@/components/bank-refund-queue";
import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { BANK_REFUND_STATUSES, type BankRefundStatus } from "@/server/db/schema";
import { listBankRefundsForFinance } from "@/server/services/bank-refunds";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Refunds to bank" };
export const dynamic = "force-dynamic";

const LABEL = { REQUESTED: "To send", PROCESSING: "Sent from bank", PAID: "Paid", FAILED: "Failed", CANCELLED: "Cancelled" } as const;

/** Finance: refunds customers asked to receive in their bank (docs/four-features-2026-10, rule bankRefunds). */
export default async function AdminBankRefundsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  const params = await searchParams;
  const status = (BANK_REFUND_STATUSES as readonly string[]).includes(params.status ?? "REQUESTED")
    ? ((params.status ?? "REQUESTED") as BankRefundStatus)
    : undefined;
  const [rows, rules] = await Promise.all([listBankRefundsForFinance({ status: params.status === "ALL" ? undefined : status }, user), getRule("bankRefunds")]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Refunds to bank"
        description="Refunds customers asked to receive in their own bank account. Send each from the bank, then record the bank's reference — or mark it failed and it goes back to the customer's wallet."
      />
      {!rules.enabled ? (
        <Alert tone="info">Refunds to bank are switched off (Business rules → bankRefunds). Requests made earlier are still shown here.</Alert>
      ) : null}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {[...BANK_REFUND_STATUSES, "ALL"].map((s) => {
          const active = s === (params.status ?? "REQUESTED");
          return (
            <Link key={s} href={`/admin/bank-refunds?status=${s}`} className={active ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}>
              {s === "ALL" ? "All" : LABEL[s as BankRefundStatus]}
            </Link>
          );
        })}
      </nav>
      <BankRefundQueue
        canManage={can(user.role, PERMISSIONS.FINANCE_MANAGE)}
        rows={rows.map((r) => ({
          id: r.id,
          status: r.status,
          amountPaise: r.amountPaise,
          accountLabel: r.accountLabel,
          accountHolderName: r.accountHolderName,
          orderNumber: r.orderNumber,
          customerName: r.customerName,
          customerEmail: r.customerEmail,
          createdAt: r.createdAt,
          payoutReference: r.payoutReference,
          failureReason: r.failureReason,
        }))}
      />
    </div>
  );
}
