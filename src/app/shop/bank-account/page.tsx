import Link from "next/link";
import { L, tr } from "@/lib/board/i18n";
import { getBoardLang } from "@/server/board-lang";
import { redirect } from "next/navigation";

import { BankAccountManager } from "@/components/bank-account-manager";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { activeShop } from "@/server/active-shop";
import { getCurrentUser } from "@/server/authz/guards";
import { bankCheckOffered } from "@/server/services/bank-account-check";
import { getBankAccountView, verificationGatewayMode } from "@/server/services/bank-accounts";
import { getRule } from "@/server/services/settings";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Payout bank account" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Payout bank account", "पेआउट बैंक खाता", "पेआउट बँक खाते"),
  noShop: L("You haven't registered a shop yet", "आपने अभी कोई दुकान रजिस्टर नहीं की है", "तुम्ही अजून दुकान नोंदवलेले नाही"),
  titleShop: L("Payout bank account — {shop}", "पेआउट बैंक खाता — {shop}", "पेआउट बँक खाते — {shop}"),
  description: L("Where GoKesari pays your settlements.", "जहाँ GoKesari आपका सेटलमेंट भेजता है।", "जिथे GoKesari तुमचे सेटलमेंट पाठवते."),
  finance: L("Finance →", "फ़ाइनेंस →", "फायनान्स →"),
  onHold: L("Payouts are on hold", "पेआउट रुके हैं", "पेआउट थांबले आहेत"),
  onHoldText: L("Settlements are paid only to a verified bank account.", "सेटलमेंट सिर्फ़ सत्यापित बैंक खाते में भेजा जाता है।", "सेटलमेंट फक्त पडताळलेल्या बँक खात्यात पाठवले जाते."),
} as const;

/** The shop's payout bank account (docs/four-features-2026-10, feature 3). */
export default async function ShopBankAccountPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [shops, lang] = await Promise.all([listShopsForOwner(user.id), getBoardLang()]);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title={tr(T.title, lang)} />
        <EmptyState title={tr(T.noShop, lang)} />
      </>
    );
  }
  const params = await searchParams;
  const shop = await activeShop(shops, params.shop);
  const [account, rules] = await Promise.all([getBankAccountView(user.id, shop.id), getRule("bankAccounts")]);
  const bankCheck = await bankCheckOffered();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={tr(T.titleShop, lang).replace("{shop}", shop.name)}
        description={tr(T.description, lang)}
        action={
          <Link href="/shop/finance" className="text-sm font-medium text-kesari-600 hover:underline">
            {tr(T.finance, lang)}
          </Link>
        }
      />
      {rules.requireVerifiedForShopPayouts && account?.status !== "VERIFIED" ? (
        <Alert tone="warning" title={tr(T.onHold, lang)}>{tr(T.onHoldText, lang)}</Alert>
      ) : null}
      <BankAccountManager account={account} saveUrl={`/api/shops/${shop.id}/bank-account`} gateway={verificationGatewayMode()} purpose="payouts" bankCheck={bankCheck} />
    </div>
  );
}
