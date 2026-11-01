import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { BankAccountManager } from "@/components/bank-account-manager";
import { BankReauth } from "@/components/rider-wallet/bank-reauth";
import { KIND_LABEL, TRANSFER_STATUS } from "@/components/rider-wallet/labels";
import { WithdrawPanel } from "@/components/rider-wallet/withdraw-panel";
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, Section } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getRiderWallet } from "@/server/rider-wallet/views";
import { bankCheckOffered } from "@/server/services/bank-account-check";
import { verificationGatewayMode } from "@/server/services/bank-accounts";

export const metadata = { title: "My wallet" };
export const dynamic = "force-dynamic";

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * The delivery partner's wallet (docs/gig-bank-payouts-2026-10): unpaid
 * earnings, withdraw to bank, the bank account, payments and the monthly payout.
 */
export default async function GigWalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const wallet = await getRiderWallet(user.id);
  if (!wallet.flags.bankAccount) notFound();
  if (!wallet.partner) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My wallet" />
        <EmptyState
          title="You're not a delivery partner yet"
          description="Apply to deliver with GoKesari; your earnings and payouts show up here."
          action={<LinkButton href="/delivery-partner/apply">Become a delivery partner</LinkButton>}
        />
      </div>
    );
  }
  const balance = wallet.balance!;
  const verified = wallet.account?.status === "VERIFIED";
  const canWithdraw = wallet.flags.withdrawal && wallet.partner.approved && verified && wallet.available;

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title="My wallet"
        description="Your unpaid delivery earnings and payments to your bank."
        action={
          <Link href="/gig/profile" className="text-sm font-medium text-kesari-600 hover:underline">
            ← My profile
          </Link>
        }
      />

      <Card className="mb-8 grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-sm text-ink-500">Unpaid earnings</p>
          <p className="text-2xl font-semibold text-ink-900">{formatPaise(Math.max(balance.availablePaise, 0))}</p>
        </div>
        <div>
          <p className="text-sm text-ink-500">On its way to your bank</p>
          <p className="text-2xl font-semibold text-ink-900">{formatPaise(balance.inFlightPaise)}</p>
        </div>
        <div>
          <p className="text-sm text-ink-500">Paid to</p>
          <p className="text-sm font-medium text-ink-900">
            {wallet.account
              ? wallet.account.method === "UPI"
                ? `UPI ${wallet.account.upiIdMasked}`
                : `${wallet.account.accountNumberMasked} · ${wallet.account.ifsc}`
              : "No bank account yet"}
          </p>
          {wallet.account ? <Badge tone={verified ? "success" : "warning"}>{verified ? "Verified" : "Not verified"}</Badge> : null}
        </div>
      </Card>

      {balance.availablePaise < 0 ? (
        <div className="mb-6">
          <Alert tone="warning">You owe {formatPaise(-balance.availablePaise)} (cash collected on delivery). It is taken from your next earnings.</Alert>
        </div>
      ) : null}

      {wallet.flags.withdrawal ? (
        <Section title="Withdraw to bank">
          {canWithdraw ? (
            <WithdrawPanel availablePaise={balance.availablePaise} minPaise={wallet.limits.minPaise} maxPaise={wallet.limits.maxPaise} leftTodayPaise={wallet.limits.leftTodayPaise} />
          ) : (
            <Alert tone="info">
              {!wallet.partner.approved
                ? "Withdrawals open once your delivery partner application is approved."
                : !verified
                  ? "Add and verify your bank account below to withdraw."
                  : "Withdrawals are not available right now. Please try again later."}
            </Alert>
          )}
          <p className="mt-2 text-xs text-ink-500">
            {formatPaise(wallet.limits.minPaise)} to {formatPaise(wallet.limits.maxPaise)} per withdrawal, up to {formatPaise(wallet.limits.dailyMaxPaise)} a day.{" "}
            {wallet.limits.feePaise > 0 ? `Fee ${formatPaise(wallet.limits.feePaise)}.` : "No fee."} Arrives {wallet.limits.settlement}. Every withdrawal is confirmed with a code we email you.
          </p>
        </Section>
      ) : null}

      {wallet.flags.monthly ? (
        <Section title="Monthly payout">
          <Card className="p-5 text-sm text-ink-600">
            On the {ordinal(wallet.monthly.day)} of every month (from {String(wallet.monthly.hourIst).padStart(2, "0")}:00) we pay what is still unpaid for the month before
            to your verified bank account — at least {formatPaise(wallet.monthly.minPaise)}; a smaller amount waits for the next month. It arrives {wallet.monthly.settlement}.
          </Card>
        </Section>
      ) : null}

      <Section title="Bank account">
        <div className="space-y-4">
          {verified ? <BankReauth canRemove /> : null}
          <BankAccountManager account={wallet.account} saveUrl="/api/bank-account" gateway={verificationGatewayMode()} purpose="payouts" bankCheck={await bankCheckOffered()} />
          <p className="text-xs text-ink-500">This is your own bank account for GoKesari — the same one used for any refund to your bank. Only the last 4 digits are ever shown.</p>
        </div>
      </Section>

      <Section title="Payments to your bank">
        {wallet.transfers.length === 0 && wallet.weekly.length === 0 ? (
          <Card className="p-5 text-sm text-ink-500">No payments yet.</Card>
        ) : (
          <Card className="divide-y divide-cream-200">
            {wallet.transfers.map((t) => (
              <Link key={t.id} href={`/gig/wallet/payouts/${t.id}`} className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-cream-50">
                <div>
                  <p className="text-sm font-medium text-ink-900">
                    {KIND_LABEL[t.kind]} · {formatPaise(t.netPaise)}
                  </p>
                  <p className="text-xs text-ink-500">
                    {when(t.createdAt)} · {t.account}
                    {t.utr ? ` · UTR ${t.utr}` : ""}
                  </p>
                </div>
                <Badge tone={TRANSFER_STATUS[t.status].tone}>{TRANSFER_STATUS[t.status].label}</Badge>
              </Link>
            ))}
            {wallet.weekly.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-4">
                <div>
                  <p className="text-sm font-medium text-ink-900">Weekly payout · {formatPaise(p.amountPaise)}</p>
                  <p className="text-xs text-ink-500">
                    {p.periodStart} – {p.periodEnd}
                    {p.reference ? ` · UTR ${p.reference}` : ""}
                  </p>
                </div>
                <Badge tone={p.status === "PAID" ? "success" : "neutral"}>{p.status === "PAID" ? "Paid" : "With finance"}</Badge>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  );
}
