import Link from "next/link";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Badge, EmptyState, LinkButton, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { currentPeriod, loadAccountsPage, monthRange } from "@/server/accounts/page";
import { listPurchases } from "@/server/accounts/purchases";

export const metadata = { title: "Purchases" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10: the purchase register for a month. */
export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const period = typeof params.period === "string" && /^\d{4}-\d{2}$/.test(params.period) ? params.period : currentPeriod();
  const { from, to } = monthRange(period);
  const rows = await listPurchases(shop.id, { from, to });
  const live = rows.filter((r) => r.status === "CONFIRMED");
  const tile = ACCOUNTS_TILES.find((t) => t.key === "purchases")!;
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="purchases" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${live.length} bill(s) · ${formatPaise(live.reduce((n, r) => n + r.totalPaise, 0))} · GST input ${formatPaise(live.reduce((n, r) => n + r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise, 0))}`} action={<LinkButton href={`/shop/accounts/capture${shopQuery}`}>+ Add bill</LinkButton>} />
      <form className="mb-3 flex items-end gap-2">
        {shopQuery ? <input type="hidden" name="shop" value={shopQuery.slice(6)} /> : null}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-700">Month</span>
          <input type="month" name="period" defaultValue={period} className={inputClass} />
        </label>
        <button type="submit" className="min-h-10 rounded-lg border border-cream-200 bg-white px-4 text-sm">Show</button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No purchases this month" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
          <table className="w-full min-w-[640px] text-sm" data-testid="purchases-table">
            <thead className="bg-cream-50 text-left text-xs text-ink-600">
              <tr>
                <th className="p-2">Date</th>
                <th className="p-2">Supplier</th>
                <th className="p-2">Invoice</th>
                <th className="p-2 text-right">Taxable</th>
                <th className="p-2 text-right">GST</th>
                <th className="p-2 text-right">Total</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-cream-100">
                  <td className="p-2 whitespace-nowrap">{r.invoiceDate}</td>
                  <td className="p-2">
                    <Link href={`/shop/accounts/purchases/${r.id}${shopQuery}`} className="font-semibold text-kesari-800 underline">
                      {r.supplierName}
                    </Link>
                    {r.supplierGstin ? <span className="block text-xs text-ink-500">{r.supplierGstin}</span> : null}
                  </td>
                  <td className="p-2">{r.invoiceNo}</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(r.taxablePaise)}</td>
                  <td className="p-2 text-right tabular-nums">{formatPaise(r.cgstPaise + r.sgstPaise + r.igstPaise + r.cessPaise)}</td>
                  <td className="p-2 text-right font-semibold tabular-nums">{formatPaise(r.totalPaise)}</td>
                  <td className="p-2">
                    <Badge tone={r.status === "CONFIRMED" ? "success" : "neutral"}>{r.status === "CONFIRMED" ? (r.version > 1 ? `Corrected (v${r.version})` : "Confirmed") : "Cancelled"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
