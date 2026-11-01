import { AccountsBoard } from "@/components/accounts/accounts-board";
import { accountsOverview } from "@/server/accounts/overview";
import { loadAccountsPage } from "@/server/accounts/page";
import { enabledFeatureKeysForShop } from "@/server/services/feature-flags";
import { postGokesariActivity } from "@/server/accounts/platform-posting";

export const metadata = { title: "Inventory & Accounts" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10: the module's own tile board. */
export default async function AccountsHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  const features = await enabledFeatureKeysForShop(shop);
  // Billing v2 (docs/billing §6.1): bring GoKesari's orders, fees, taxes and payouts into the books first.
  if (features.includes("billing_v2")) await postGokesariActivity(shop.id).catch((error) => console.error("[books] GoKesari posting failed", shop.id, error));
  const overview = await accountsOverview(shop.id);
  return (
    <div className="mx-auto flex min-h-[calc(100svh-8rem)] w-full max-w-6xl flex-col">
      <AccountsBoard lang={lang} shopName={shop.name} overview={overview} shopQuery={shopQuery} features={features} />
    </div>
  );
}
