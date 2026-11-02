import { redirect } from "next/navigation";

import { AccountsNav } from "@/components/accounts/accounts-nav";
import { PosScreen } from "@/components/billing/pos-screen";
import { loadAccountsPage } from "@/server/accounts/page";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";

export const metadata = { title: "Counter POS" };
export const dynamic = "force-dynamic";

/**
 * Billing v2 (docs/billing §4.7): counter billing that keeps working without
 * the internet — on the website and in the GoKesari app. Bills made offline
 * get their invoice number when they reach GoKesari.
 */
export default async function PosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabledForShop("billing_v2", shop))) redirect(`/shop/accounts${shopQuery}`);
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="sales" shopQuery={shopQuery} />
      <PosScreen shopId={shop.id} shopName={shop.name} />
    </div>
  );
}
