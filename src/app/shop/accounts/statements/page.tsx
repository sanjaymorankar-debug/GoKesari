import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { formatPaise } from "@/lib/money";
import { currentPeriod, loadAccountsPage } from "@/server/accounts/page";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { shopTaxStatement } from "@/server/tax/compliance";
import { shopWalletStatement } from "@/server/tax/statements";

export const metadata = { title: "Statements from GoKesari" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

/**
 * Billing v2 (docs/billing §5.4–5.6): what GoKesari collected or deducted for
 * the month — GST TCS (claim it in GST), income-tax TDS (claim it in the
 * income-tax return), the prepaid wallet and the order-level settlement —
 * each as PDF / CSV. One screen.
 */
export default async function StatementsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabledForShop("billing_v2", shop))) redirect(`/shop/accounts${shopQuery}`);
  const now = currentPeriod();
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) ? params.period : now;
  const [tax, wallet] = await Promise.all([shopTaxStatement(shop.id, period), shopWalletStatement(shop.id, period)]);
  const base = `/api/shops/${shop.id}/accounts/statements`;
  const link = (kind: string, format: string) => `${base}/${kind}?period=${period}&format=${format}`;
  const cards = [
    { key: "tax", title: "GST TCS and income-tax TDS", lines: [`Net taxable supplies ${formatPaise(tax.tcs.netPaise)}`, `TCS ${formatPaise(tax.tcs.igstPaise + tax.tcs.cgstPaise + tax.tcs.sgstPaise)} (shows in your GSTR-2B)`, `TDS ${formatPaise(tax.tds.tdsPaise)} (claim in your income-tax return)`], files: [["PDF", link("tax", "pdf")], ["CSV", link("tax", "csv")]] },
    { key: "wallet", title: "Shop wallet", lines: [`Opening ${formatPaise(wallet.openingPaise)} · closing ${formatPaise(wallet.closingPaise)}`, `Top-ups ${formatPaise(wallet.topUpsPaise)} · deductions ${formatPaise(wallet.deductionsPaise)}`, `${wallet.feeInvoices.length} GoKesari tax invoice(s) for fees`], files: [["PDF", link("wallet", "pdf")], ["CSV", link("wallet", "csv")]] },
    { key: "settlement", title: "Order-level settlement", lines: [`${tax.orders} order(s) settled this month`, "Goods, commission, delivery, GST on fees, TCS, TDS, refunds, net — one row per order"], files: [["CSV", link("settlement", "csv")]] },
  ];
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="statements" shopQuery={shopQuery} />
      <AccountsHeader title="Statements from GoKesari" subtitle={`${shop.name} — what GoKesari collected, deducted and settled.`} />
      <form method="get" action="/shop/accounts/statements" className="mb-3 flex items-center gap-1.5">
        {shopQuery ? <input type="hidden" name="shop" value={shop.id} /> : null}
        <label htmlFor="period" className="text-sm font-semibold text-ink-700">
          Month
        </label>
        <input id="period" type="month" name="period" defaultValue={period} max={now} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm" />
        <button type="submit" className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-kesari-50">
          Show
        </button>
      </form>
      <ul className="grid gap-2 sm:grid-cols-3" data-testid="statement-cards">
        {cards.map((c) => (
          <li key={c.key} className="flex flex-col gap-1.5 rounded-2xl border border-[var(--gk-line)] bg-white p-3">
            <p className="font-bold text-ink-900">{c.title}</p>
            {c.lines.map((l) => (
              <p key={l} className="text-sm text-ink-700">
                {l}
              </p>
            ))}
            <div className="mt-auto flex gap-2 pt-1">
              {c.files.map(([label, href]) => (
                <a key={label} href={href} className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-3 text-sm font-bold text-white hover:bg-kesari-800">
                  {label}
                </a>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
