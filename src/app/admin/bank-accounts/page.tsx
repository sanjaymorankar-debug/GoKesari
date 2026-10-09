import Link from "next/link";
import { redirect } from "next/navigation";

import { BankCheckAdminCard } from "@/components/bank-check-admin-card";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { BANK_STATUS_LABELS, VERIFICATION_METHOD_LABELS, type VerificationMethod } from "@/lib/bank-accounts";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { bankCheckAdminStatus } from "@/server/services/bank-account-check";
import { listBankAccountsForFinance } from "@/server/services/bank-accounts";

export const metadata = { title: "Bank accounts" };
export const dynamic = "force-dynamic";

const STATUSES = ["PENDING", "VERIFIED", "FAILED"] as const;
const TONE = { PENDING: "warning", VERIFIED: "success", FAILED: "danger" } as const;

/** Finance: bank accounts and their ₹1 verification (docs/four-features-2026-10, feature 3). Masked only. */
export default async function AdminBankAccountsPage({ searchParams }: { searchParams: Promise<{ status?: string; holder?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.FINANCE_VIEW)) redirect("/");
  const params = await searchParams;
  const status = (STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as (typeof STATUSES)[number]) : undefined;
  const holderType = params.holder === "SHOP" || params.holder === "CUSTOMER" ? params.holder : undefined;
  const accounts = await listBankAccountsForFinance({ status, holderType }, user);
  const bankCheckStatus = await bankCheckAdminStatus(user);
  const link = (s?: string, h?: string) => `/admin/bank-accounts?${new URLSearchParams({ ...(s ? { status: s } : {}), ...(h ? { holder: h } : {}) })}`;

  return (
    <div className="space-y-4">
      <PageHeader title="Bank accounts" description="Customers' refund accounts and shops' payout accounts, with their ₹1 verification. Numbers are masked." />
      <BankCheckAdminCard status={bankCheckStatus} canManage={can(user.role, PERMISSIONS.FINANCE_MANAGE)} />
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Filter">
        {[undefined, ...STATUSES].map((s) => (
          <Link key={s ?? "all"} href={link(s, holderType)} className={s === status ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}>
            {s ? BANK_STATUS_LABELS[s] : "All"}
          </Link>
        ))}
        <span className="px-2 text-ink-500">|</span>
        {[undefined, "SHOP", "CUSTOMER"].map((h) => (
          <Link key={h ?? "both"} href={link(status, h)} className={h === holderType ? "rounded-full bg-kesari-600 px-3 py-1 text-white" : "rounded-full bg-cream-100 px-3 py-1 text-ink-700"}>
            {h === "SHOP" ? "Shops" : h === "CUSTOMER" ? "Customers" : "Shops and customers"}
          </Link>
        ))}
      </nav>
      {accounts.length === 0 ? (
        <EmptyState title="No bank accounts here." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Verified by</th>
                <th className="px-3 py-2">Gateway ref · refund</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-100">
              {accounts.map((a) => (
                <tr key={a.id} data-testid="bank-account-row">
                  <td className="px-3 py-2">
                    <p className="font-medium text-ink-900">{a.accountHolderName}</p>
                    <p className="text-xs text-ink-500">{a.shopName ? `Shop: ${a.shopName}` : `Customer: ${a.ownerName ?? a.ownerEmail}`}</p>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{a.method === "UPI" ? a.upiIdMasked : `${a.accountNumberMasked} · ${a.ifsc}`}</td>
                  <td className="px-3 py-2">
                    <Badge tone={TONE[a.status]}>{BANK_STATUS_LABELS[a.status]}</Badge>
                    {a.failureReason ? <p className="mt-1 max-w-xs text-xs text-red-700">{a.failureReason}</p> : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {a.verificationPaymentMethod ? VERIFICATION_METHOD_LABELS[a.verificationPaymentMethod as VerificationMethod] ?? a.verificationPaymentMethod : "—"}
                    {a.matchMethod ? <span className="block text-ink-500">{a.matchMethod === "PAYMENT_ONLY" ? "payment only (name not given by gateway)" : `matched: ${a.matchedAccountHolderName}`}</span> : null}
                    {a.bankCheck ? (
                      <span className="block text-ink-500" data-testid="bank-check-row">
                        bank check {a.bankCheck.result.toLowerCase().replace(/_/g, " ")}
                        {a.bankCheck.nameMatchResult ? ` · ${a.bankCheck.nameMatchResult.toLowerCase().replace(/_/g, " ")}` : ""}
                        {a.bankCheck.bankName ? ` · ${a.bankCheck.bankName}${a.bankCheck.branch ? `, ${a.bankCheck.branch}` : ""}` : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {a.gatewayReference ?? "—"}
                    {a.lastAttempt ? <span className="block text-ink-500">refund {a.lastAttempt.refundStatus.toLowerCase().replace(/_/g, " ")}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
