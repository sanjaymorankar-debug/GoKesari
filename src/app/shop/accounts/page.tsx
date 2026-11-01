import { AccountsBoard } from "@/components/accounts/accounts-board";
import { accountsOverview } from "@/server/accounts/overview";
import { loadAccountsPage } from "@/server/accounts/page";
import { enabledFeatureKeys } from "@/server/services/feature-flags";

export const metadata = { title: "Inventory & Accounts" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10: the module's own tile board. */
export default async function AccountsHomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  const [overview, features] = await Promise.all([accountsOverview(shop.id), enabledFeatureKeys()]);
  return (
    <div className="mx-auto flex min-h-[calc(100svh-8rem)] w-full max-w-6xl flex-col">
      <AccountsBoard lang={lang} shopName={shop.name} overview={overview} shopQuery={shopQuery} features={features} />
    </div>
  );
}
