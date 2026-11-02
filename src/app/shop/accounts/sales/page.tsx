import Link from "next/link";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Badge, EmptyState } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_NAV } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { currentPeriod, loadAccountsPage, monthRange } from "@/server/accounts/page";
import { listSalesInvoices } from "@/server/accounts/sales";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";

export const metadata = { title: "Sales invoices" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function href(path: string, params: Record<string, string | undefined>, shopQuery: string): string {
  const sp = new URLSearchParams(shopQuery.slice(1));
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

function shiftMonth(period: string, by: number): string {
  const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

const monthLabel = (period: string) => new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });

const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK: "Bank", CARD: "Card", CREDIT: "Credit" };

/** docs/inventory-accounting-2026-10, Part 2: the shop's own GST sales invoices, month by month. */
export default async function SalesRegisterPage({ searchParams }: { searchParams: Promise<SP> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const now = currentPeriod();
  const period = typeof params.period === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.period) ? params.period : now;
  const { from, to } = monthRange(period);
  const invoices = await listSalesInvoices(shop.id, { from, to });
  const issued = invoices.filter((i) => i.status === "ISSUED");
  const total = issued.reduce((n, i) => n + i.totalPaise, 0);
  const tax = issued.reduce((n, i) => n + i.cgstPaise + i.sgstPaise + i.igstPaise + i.cessPaise, 0);
  const credit = issued.filter((i) => i.paymentMode === "CREDIT").reduce((n, i) => n + i.totalPaise, 0);
  const navLabel = ACCOUNTS_NAV.find((n) => n.key === "sales")!.label;
  // Billing v2 (docs/billing §4.7): the offline-first counter POS.
  const posOn = await isFeatureEnabledForShop("billing_v2", shop);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="sales" shopQuery={shopQuery} />
      <AccountsHeader
        title={tr(navLabel, lang)}
        subtitle={`${shop.name} — GST invoices for counter and B2B sales. GoKesari orders have their own invoices.`}
        action={
          <span className="flex flex-wrap gap-2">
            {posOn ? (
              <Link href={href("/shop/accounts/pos", {}, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl border border-kesari-700 px-4 text-sm font-bold text-kesari-800 hover:bg-kesari-50">
                Counter POS (works offline)
              </Link>
            ) : null}
            <Link href={href("/shop/accounts/sales/new", {}, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
              + New invoice
            </Link>
          </span>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <Link href={href("/shop/accounts/sales", { period: shiftMonth(period, -1) }, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50" aria-label="Previous month">
          ←
        </Link>
        <form method="get" action="/shop/accounts/sales" className="flex items-center gap-1.5">
          {shopQuery ? <input type="hidden" name="shop" value={shop.id} /> : null}
          <label htmlFor="period" className="sr-only">
            Month
          </label>
          <input id="period" type="month" name="period" defaultValue={period} max={now} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm" />
          <button type="submit" className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-kesari-50">
            Show
          </button>
        </form>
        {period < now ? (
          <Link href={href("/shop/accounts/sales", { period: shiftMonth(period, 1) }, shopQuery)} className="inline-flex min-h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50" aria-label="Next month">
            →
          </Link>
        ) : null}
        <span className="ml-1 text-sm font-semibold text-ink-700">{monthLabel(period)}</span>
      </div>

      <ul className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {[
          { label: "Invoices", value: String(issued.length) },
          { label: "Sales (incl. GST)", value: formatPaise(total) },
          { label: "GST collected", value: formatPaise(tax) },
          { label: "On credit", value: formatPaise(credit) },
        ].map((f) => (
          <li key={f.label} className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
            <span className="text-xs font-semibold text-ink-600">{f.label}</span>
            <span className="text-lg font-bold tabular-nums text-green-800">{f.value}</span>
          </li>
        ))}
      </ul>

      {invoices.length === 0 ? (
        <EmptyState title={`No sales invoices in ${monthLabel(period)}`} description="Create a GST invoice for a counter or business customer." />
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white" aria-label="Sales invoices">
          {invoices.map((inv) => (
            <li key={inv.id} className="border-b border-[var(--gk-line)] last:border-b-0">
              <Link href={href(`/shop/accounts/sales/${inv.id}`, {}, shopQuery)} className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-kesari-50">
                <span className="w-14 shrink-0 text-sm text-ink-600 tabular-nums">{dayLabel(inv.invoiceDate)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-ink-900">{inv.invoiceNo}</span>
                  <span className="block truncate text-xs text-ink-600">
                    {inv.buyerName ?? "Cash customer"}
                    {inv.buyerGstin ? ` · ${inv.buyerGstin}` : ""} · {MODE_LABEL[inv.paymentMode] ?? inv.paymentMode}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className={`text-sm font-bold tabular-nums ${inv.status === "CANCELLED" ? "text-ink-500 line-through" : "text-ink-900"}`}>{formatPaise(inv.totalPaise)}</span>
                  {inv.status === "CANCELLED" ? <Badge tone="danger">Cancelled</Badge> : <Badge tone="success">Issued</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
