import Link from "next/link";
import { redirect } from "next/navigation";

import { BankRefundsPanel } from "@/components/bank-refunds-panel";
import { WalletView } from "@/components/wallet-view";
import { SubmenuStrip } from "@/components/board/submenu-strip";
import { Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getCustomerBankRefunds } from "@/server/services/bank-refunds";
import { getRule } from "@/server/services/settings";
import { getWalletForecast } from "@/server/services/subscriptions";
import {
  getOrCreateWallet,
  listTransactions,
  todaysDeductionPaise,
} from "@/server/services/wallet";

export const metadata = { title: "My Wallet" };
export const dynamic = "force-dynamic";

export default async function WalletPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [wallet, todaysDeduction, forecast, transactions, referrals] = await Promise.all([
    getOrCreateWallet(user.id),
    todaysDeductionPaise(user.id),
    getWalletForecast(user.id, 15),
    listTransactions(user.id, { limit: 30 }),
    getRule("customerReferrals"),
  ]);
  // Refunds to bank (docs/four-features-2026-10, rule bankRefunds): null while the rule is off.
  const [bankRefunds, lang] = await Promise.all([getCustomerBankRefunds(user.id), getBoardLang()]);

  return (
    <>
      <PageHeader
        title="My Wallet"
        description="Top up once, then orders and subscriptions are paid automatically."
      />
      <SubmenuStrip board="customer" menuKey="wallet" role={user.role} lang={lang} />
      {referrals.enabled ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-2 p-4" data-testid="refer-card">
          <p className="text-sm text-ink-700">
            Invite friends — you get {formatPaise(referrals.referrerRewardPaise)} when their first order is delivered.
          </p>
          <Link href="/refer" className="text-sm font-medium text-kesari-700 hover:underline">
            Refer a friend →
          </Link>
        </Card>
      ) : null}
      <WalletView
        balancePaise={wallet.balancePaise}
        promotionalBalancePaise={wallet.promotionalBalancePaise}
        lowBalanceThresholdPaise={wallet.lowBalanceThresholdPaise}
        todaysDeductionPaise={todaysDeduction}
        forecast={forecast}
        transactions={transactions.map((t) => ({
          id: t.id,
          type: t.type,
          amountPaise: t.amountPaise,
          newBalancePaise: t.newBalancePaise,
          description: t.description,
          createdAt: t.createdAt.toISOString(),
        }))}
      />
      {bankRefunds ? <BankRefundsPanel info={bankRefunds} /> : null}
    </>
  );
}
