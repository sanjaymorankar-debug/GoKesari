import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { JournalForms } from "@/components/billing/journal-forms";
import { BOOK_ACCOUNT_LABELS, BOOK_ACCOUNTS } from "@/lib/accounts/constants";
import { loadAccountsPage } from "@/server/accounts/page";
import { stockSummary } from "@/server/accounts/stock";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Journal, contra & stock journal" };
export const dynamic = "force-dynamic";

/** Billing v2 (docs/billing §6.1, §6.2): the shop's manual vouchers. */
export default async function JournalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabled("billing_v2"))) redirect(`/shop/accounts${shopQuery}`);
  const stock = await stockSummary(shop.id);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <AccountsNav lang={lang} current="journals" shopQuery={shopQuery} />
      <AccountsHeader title="Journal, contra & stock journal" subtitle={`${shop.name} — vouchers are reversed, never edited.`} />
      <JournalForms
        shopId={shop.id}
        accounts={BOOK_ACCOUNTS.filter((a) => a !== "PARTY").map((a) => ({ value: a, label: BOOK_ACCOUNT_LABELS[a] }))}
        items={stock.rows.map((r) => ({ value: r.shopProductId, label: `${r.name} (${r.sellableUnit})` }))}
      />
    </div>
  );
}
