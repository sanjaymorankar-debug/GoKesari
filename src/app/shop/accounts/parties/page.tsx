import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { AddPartyForm } from "@/components/accounts/party-forms";
import { EmptyState } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { loadAccountsPage } from "@/server/accounts/page";
import { ageing, listParties, type AgeingRow } from "@/server/accounts/parties";

export const metadata = { title: "Suppliers & customers" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "suppliers", label: "Suppliers" },
  { key: "customers", label: "Customers" },
  { key: "payables", label: "You owe (ageing)" },
  { key: "receivables", label: "Owed to you (ageing)" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const KIND_LABEL = { SUPPLIER: "Supplier", CUSTOMER: "Customer", BOTH: "Supplier & customer" } as const;

function tabHref(tab: Tab, shopQuery: string) {
  const sp = new URLSearchParams(shopQuery.slice(1));
  sp.set("tab", tab);
  return `/shop/accounts/parties?${sp.toString()}`;
}

/** Positive = the shop owes the party. */
function Balance({ paise }: { paise: number }) {
  if (paise === 0) return <span className="text-sm text-ink-500">Settled</span>;
  return (
    <span className="flex flex-col items-end">
      <span className={clsx("text-sm font-bold tabular-nums", paise > 0 ? "text-red-800" : "text-green-800")}>{formatPaise(Math.abs(paise))}</span>
      <span className="text-xs text-ink-600">{paise > 0 ? "you owe" : "they owe"}</span>
    </span>
  );
}

function AgeingTable({ rows, side, shopQuery }: { rows: AgeingRow[]; side: "PAYABLE" | "RECEIVABLE"; shopQuery: string }) {
  if (rows.length === 0) {
    return <EmptyState title={side === "PAYABLE" ? "Nothing due to suppliers" : "Nothing due from customers"} description={side === "PAYABLE" ? "Every confirmed supplier bill is paid." : "Every credit invoice is received."} />;
  }
  const cols = [
    { key: "current", label: "Not due yet" },
    { key: "d30", label: "1–30 days" },
    { key: "d60", label: "31–60 days" },
    { key: "d90", label: "61–90 days" },
    { key: "over90", label: "90+ days" },
  ] as const;
  const sum = (k: (typeof cols)[number]["key"]) => rows.reduce((n, r) => n + r.buckets[k], 0);
  const total = rows.reduce((n, r) => n + r.totalPaise, 0);
  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="sr-only">{side === "PAYABLE" ? "Unpaid supplier bills by days past due" : "Unpaid customer invoices by days past due"}</caption>
        <thead>
          <tr className="border-b border-[var(--gk-line)] text-left text-xs text-ink-600">
            <th scope="col" className="px-3 py-2">{side === "PAYABLE" ? "Supplier" : "Customer"}</th>
            {cols.map((c) => (
              <th key={c.key} scope="col" className="px-3 py-2 text-right">
                {c.label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.partyId} className="border-b border-[var(--gk-line)]">
              <th scope="row" className="px-3 py-2 text-left font-semibold">
                <Link href={`/shop/accounts/parties/${r.partyId}${shopQuery}`} className="text-ink-900 hover:underline">
                  {r.name}
                </Link>
                {r.oldestDueDate ? <span className="block text-xs font-normal text-ink-600">oldest due {r.oldestDueDate}</span> : null}
              </th>
              {cols.map((c) => (
                <td key={c.key} className={clsx("px-3 py-2 text-right", c.key === "over90" && r.buckets.over90 > 0 && "font-bold text-red-800")}>
                  {r.buckets[c.key] ? formatPaise(r.buckets[c.key]) : "—"}
                </td>
              ))}
              <td className="px-3 py-2 text-right font-bold">{formatPaise(r.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="tabular-nums">
          <tr className="bg-cream-50 font-bold">
            <th scope="row" className="px-3 py-2 text-left">Total</th>
            {cols.map((c) => (
              <td key={c.key} className="px-3 py-2 text-right">
                {formatPaise(sum(c.key))}
              </td>
            ))}
            <td className="px-3 py-2 text-right">{formatPaise(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** docs/inventory-accounting-2026-10, Part 2: suppliers, customers, their balances and ageing. */
export default async function PartiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const tab: Tab = TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : "suppliers";
  const tile = ACCOUNTS_TILES.find((t) => t.key === "parties")!;

  const parties = tab === "suppliers" || tab === "customers" ? await listParties(shop.id, tab === "suppliers" ? "SUPPLIER" : "CUSTOMER") : null;
  const ageingRows = tab === "payables" ? await ageing(shop.id, "PAYABLE") : tab === "receivables" ? await ageing(shop.id, "RECEIVABLE") : null;
  const owe = parties?.filter((p) => p.balancePaise > 0).reduce((n, p) => n + p.balancePaise, 0) ?? 0;
  const owed = parties?.filter((p) => p.balancePaise < 0).reduce((n, p) => n - p.balancePaise, 0) ?? 0;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="parties" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${shop.name} — balances: positive means you owe them.`} />

      <nav aria-label="Party views" className="-mx-2 mb-3 flex gap-1.5 overflow-x-auto px-2 pb-1 [scrollbar-width:none]">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key, shopQuery)}
            aria-current={tab === t.key ? "page" : undefined}
            className={clsx("flex min-h-11 shrink-0 items-center rounded-xl px-3 text-sm font-semibold", tab === t.key ? "bg-green-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-green-50")}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {parties ? (
        <>
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <ul className="grid flex-1 grid-cols-2 gap-1.5 sm:max-w-md">
              <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
                <span className="text-xs font-semibold text-ink-600">You owe</span>
                <span className="text-lg font-bold tabular-nums text-red-800">{formatPaise(owe)}</span>
              </li>
              <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
                <span className="text-xs font-semibold text-ink-600">Owed to you</span>
                <span className="text-lg font-bold tabular-nums text-green-800">{formatPaise(owed)}</span>
              </li>
            </ul>
          </div>
          <div className="mb-3">
            <AddPartyForm shopId={shop.id} defaultKind={tab === "customers" ? "CUSTOMER" : "SUPPLIER"} shopQuery={shopQuery} />
          </div>
          {parties.length === 0 ? (
            <EmptyState title={tab === "suppliers" ? "No suppliers yet" : "No customers yet"} description={tab === "suppliers" ? "Suppliers are added automatically when you confirm their bills, or add one here." : "Customers are added when you give credit on an invoice, or add one here."} />
          ) : (
            <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white" aria-label={tab === "suppliers" ? "Suppliers" : "Customers"}>
              {parties.map((p) => (
                <li key={p.id} className="border-b border-[var(--gk-line)] last:border-b-0">
                  <Link href={`/shop/accounts/parties/${p.id}${shopQuery}`} className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-green-50">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-ink-900">{p.name}</span>
                      <span className="block truncate text-xs text-ink-600">
                        {KIND_LABEL[p.kind]}
                        {p.gstin ? ` · ${p.gstin}` : ""}
                        {p.phone ? ` · ${p.phone}` : ""}
                      </span>
                    </span>
                    <Balance paise={p.balancePaise} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {ageingRows ? <AgeingTable rows={ageingRows} side={tab === "payables" ? "PAYABLE" : "RECEIVABLE"} shopQuery={shopQuery} /> : null}
      {ageingRows ? <p className="mt-2 text-xs text-ink-600">Days past each bill&apos;s due date. Payments not linked to a bill settle the oldest bills first.</p> : null}
    </div>
  );
}
