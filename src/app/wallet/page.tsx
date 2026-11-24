import Link from "next/link";
import { redirect } from "next/navigation";

import { BankRefundsPanel } from "@/components/bank-refunds-panel";
import { WalletView } from "@/components/wallet-view";
import { SubmenuStrip } from "@/components/board/submenu-strip";
import { Card, PageHeader } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { L, tr } from "@/lib/board/i18n";
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

/** Module 6 (docs/hindi-marathi-2026-11): the wallet page's own wording. */
const T = {
  title: L("My Wallet", "मेरा वॉलेट", "माझे वॉलेट"),
  description: L(
    "Top up once, then orders and subscriptions are paid automatically.",
    "एक बार पैसे जोड़ें, फिर ऑर्डर और सब्सक्रिप्शन का भुगतान अपने आप होगा।",
    "एकदा पैसे भरा, मग ऑर्डर आणि सदस्यतांचे पेमेंट आपोआप होईल.",
  ),
  invite: L(
    "Invite friends — you get {amount} when their first order is delivered.",
    "दोस्तों को बुलाएँ — उनका पहला ऑर्डर डिलीवर होने पर आपको {amount} मिलेंगे।",
    "मित्रांना बोलवा — त्यांची पहिली ऑर्डर पोहोचल्यावर तुम्हाला {amount} मिळतील.",
  ),
  refer: L("Refer a friend →", "दोस्त को रेफ़र करें →", "मित्राला रेफर करा →"),
} as const;

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
        title={tr(T.title, lang)}
        description={tr(T.description, lang)}
      />
      <SubmenuStrip board="customer" menuKey="wallet" role={user.role} lang={lang} />
      {referrals.enabled ? (
        <Card className="mb-4 flex flex-wrap items-center justify-between gap-2 p-4" data-testid="refer-card">
          <p className="text-sm text-ink-700">
            {tr(T.invite, lang).replace("{amount}", formatPaise(referrals.referrerRewardPaise))}
          </p>
          <Link href="/refer" className="text-sm font-medium text-kesari-700 hover:underline">
            {tr(T.refer, lang)}
          </Link>
        </Card>
      ) : null}
      <WalletView
        balancePaise={wallet.balancePaise}
        promotionalBalancePaise={wallet.promotionalBalancePaise}
        lowBalanceThresholdPaise={wallet.lowBalanceThresholdPaise}
        todaysDeductionPaise={todaysDeduction}
        forecast={forecast}
        lang={lang}
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
