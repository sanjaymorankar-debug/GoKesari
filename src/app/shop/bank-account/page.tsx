import Link from "next/link";
import { redirect } from "next/navigation";

import { BankAccountManager } from "@/components/bank-account-manager";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { bankCheckOffered } from "@/server/services/bank-account-check";
import { getBankAccountView, verificationGatewayMode } from "@/server/services/bank-accounts";
import { getRule } from "@/server/services/settings";
import { listShopsForOwner } from "@/server/services/shops";

export const metadata = { title: "Payout bank account" };
export const dynamic = "force-dynamic";

/** The shop's payout bank account (docs/four-features-2026-10, feature 3). */
export default async function ShopBankAccountPage({ searchParams }: { searchParams: Promise<{ shop?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const shops = await listShopsForOwner(user.id);
  if (shops.length === 0) {
    return (
      <>
        <PageHeader title="Payout bank account" />
        <EmptyState title="You haven't registered a shop yet" />
      </>
    );
  }
  const params = await searchParams;
  const shop = shops.find((s) => s.id === params.shop) ?? shops[0];
  const [account, rules] = await Promise.all([getBankAccountView(user.id, shop.id), getRule("bankAccounts")]);
  const bankCheck = await bankCheckOffered();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={`Payout bank account — ${shop.name}`}
        description="Where GoKesari pays your settlements."
        action={
          <Link href="/shop/finance" className="text-sm font-medium text-kesari-600 hover:underline">
            Finance →
          </Link>
        }
      />
      {rules.requireVerifiedForShopPayouts && account?.status !== "VERIFIED" ? (
        <Alert tone="warning" title="Payouts are on hold">Settlements are paid only to a verified bank account.</Alert>
      ) : null}
      <BankAccountManager account={account} saveUrl={`/api/shops/${shop.id}/bank-account`} gateway={verificationGatewayMode()} purpose="payouts" bankCheck={bankCheck} />
    </div>
  );
}
