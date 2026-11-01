import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { SyncPanel } from "@/components/billing/sync-panel";
import { loadAccountsPage, monthRange } from "@/server/accounts/page";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { syncDashboard } from "@/server/sync/engine";
import { LAYOUTS } from "@/server/sync/formats";
import { buildCanonicalBooks, uqcOf, shopUnitMap } from "@/server/sync/model";
import { todayIst } from "@/server/accounts/books";

export const metadata = { title: "Sync with accounting software" };
export const dynamic = "force-dynamic";

/**
 * Billing v2 (docs/billing §7, §8): send the books to TallyPrime, Busy, Marg,
 * Vyapar, myBillBook, Zoho Books, Odoo or any software, and bring theirs in —
 * both ways, accounts and inventory — with the conflicts to decide, the units
 * to map and the template pack. One screen.
 */
export default async function SyncPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabled("billing_v2"))) redirect(`/shop/accounts${shopQuery}`);
  const month = monthRange(todayIst().slice(0, 7));
  const [dashboard, books, unitMap] = await Promise.all([syncDashboard(shop.id), buildCanonicalBooks(shop.id, month.from, month.to), shopUnitMap(shop.id)]);
  const unmapped = books.units.filter((u) => !uqcOf(u.symbol, unitMap)).map((u) => u.symbol);
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="sync" shopQuery={shopQuery} />
      <AccountsHeader title="Sync with accounting software" subtitle={`${shop.name} — accounts and stock, both ways. Masters go before vouchers; nothing is overwritten without asking.`} />
      <SyncPanel
        shopId={shop.id}
        lang={lang}
        defaultFrom={month.from}
        defaultTo={month.to}
        tools={dashboard.systems.map((s) => ({ ...s, file: LAYOUTS[s.system as keyof typeof LAYOUTS].file, lastExport: s.lastExport ? new Date(s.lastExport).toISOString() : null, lastImport: s.lastImport ? new Date(s.lastImport).toISOString() : null }))}
        conflicts={dashboard.conflicts.map((c) => ({ id: c.id, system: c.system, entityType: c.entityType, externalKey: c.externalKey, local: c.localSnapshot, incoming: c.incomingSnapshot }))}
        unmappedUnits={unmapped}
      />
    </div>
  );
}
