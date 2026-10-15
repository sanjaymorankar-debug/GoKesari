import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Alert, Badge, EmptyState } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { formatMilli } from "@/lib/accounts/units";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { loadAccountsPage } from "@/server/accounts/page";
import { expiringBatches, ledgerDrift, stockSummary } from "@/server/accounts/stock";

export const metadata = { title: "Stock" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "", label: "All" },
  { key: "low", label: "Low" },
  { key: "out", label: "Out of stock" },
  { key: "expiring", label: "Expiring" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const METHOD_LABEL = { FIFO: "FIFO (first in, first out)", WAVG: "Weighted average cost" } as const;
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });

function href(params: Record<string, string | undefined>, shopQuery: string) {
  const sp = new URLSearchParams(shopQuery.slice(1));
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `/shop/accounts/stock?${s}` : "/shop/accounts/stock";
}

/** docs/inventory-accounting-2026-10, Part 1: what is on the shelf, what it is worth, what runs out or expires. */
export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const filter: Filter = FILTERS.some((f) => f.key === params.status) ? (params.status as Filter) : "";
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 80) : "";
  const [summary, expiring, drift] = await Promise.all([stockSummary(shop.id), expiringBatches(shop.id), ledgerDrift(shop.id)]);
  const expiringIds = new Set(expiring.map((b) => b.shopProductId));
  const names = new Map(summary.rows.map((r) => [r.shopProductId, r.name]));

  const counts = {
    low: summary.rows.filter((r) => r.status === "LOW_STOCK").length,
    out: summary.rows.filter((r) => r.status === "OUT_OF_STOCK").length,
    expiring: expiringIds.size,
  };
  const rows = summary.rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "low") return r.status === "LOW_STOCK";
    if (filter === "out") return r.status === "OUT_OF_STOCK";
    if (filter === "expiring") return expiringIds.has(r.shopProductId);
    return true;
  });
  const tile = ACCOUNTS_TILES.find((t) => t.key === "stock")!;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="stock" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${shop.name} — online orders reduce stock automatically the moment they are placed.`} />

      {drift.length ? (
        <div className="mb-3">
          <Alert tone="warning" title="Stock count and books disagree">
            {drift.length} listing count{drift.length === 1 ? "" : "s"} differ from the stock ledger:{" "}
            {drift
              .slice(0, 5)
              .map((d) => `${names.get(d.shopProductId) ?? "a product"} (${d.channel.toLowerCase()}: books ${d.ledgerUnits}, listing ${d.stockUnits})`)
              .join("; ")}
            {drift.length > 5 ? "…" : ""}. Do a physical count on the product to set it right, or contact GoKesari support.
          </Alert>
        </div>
      ) : null}

      <ul className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <li className="col-span-2 flex min-h-14 flex-col justify-center rounded-xl bg-teal-100 px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-700">Stock value at cost</span>
          <span className="text-xl font-bold tabular-nums text-teal-800">{formatPaise(summary.totalValuePaise)}</span>
          <span className="text-xs text-ink-700">{METHOD_LABEL[summary.method]}</span>
        </li>
        <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">Low / out</span>
          <span className="text-lg font-bold tabular-nums text-kesari-800">
            {counts.low} / {counts.out}
          </span>
        </li>
        <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">Expiring soon</span>
          <span className="text-lg font-bold tabular-nums text-red-800">{counts.expiring}</span>
        </li>
      </ul>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <form method="get" action="/shop/accounts/stock" className="flex min-w-0 flex-1 items-center gap-1.5 sm:max-w-sm" role="search">
          {shopQuery ? <input type="hidden" name="shop" value={shop.id} /> : null}
          {filter ? <input type="hidden" name="status" value={filter} /> : null}
          <label htmlFor="stock-q" className="sr-only">
            Search products
          </label>
          <input id="stock-q" type="search" name="q" defaultValue={q} placeholder="Search products" className="min-h-11 min-w-0 flex-1 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm" />
          <button type="submit" className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold hover:bg-teal-50">
            Search
          </button>
        </form>
        <nav aria-label="Filter stock" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {FILTERS.map((f) => (
            <Link
              key={f.key || "all"}
              href={href({ status: f.key || undefined, q: q || undefined }, shopQuery)}
              aria-current={filter === f.key ? "page" : undefined}
              className={clsx("flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-3 text-sm font-semibold", filter === f.key ? "bg-teal-700 text-white" : "border border-[var(--gk-line)] bg-white text-ink-900 hover:bg-teal-50")}
            >
              {f.label}
              {f.key ? <span className="tabular-nums opacity-80">({counts[f.key]})</span> : null}
            </Link>
          ))}
        </nav>
      </div>

      {expiring.length && (filter === "" || filter === "expiring") && !q ? (
        <section className="mb-3 rounded-2xl border border-red-200 bg-red-50 p-3" aria-labelledby="expiring-title">
          <h2 id="expiring-title" className="mb-1.5 text-base font-bold text-red-900">
            Expiring soon
          </h2>
          <ul className="flex flex-col gap-1">
            {expiring.slice(0, filter === "expiring" ? 100 : 6).map((b) => (
              <li key={b.batchId}>
                <Link href={`/shop/accounts/stock/${b.shopProductId}${shopQuery}`} className="flex min-h-11 items-center gap-2 rounded-xl bg-white px-3 py-1.5 text-sm hover:bg-red-100">
                  <span className="min-w-0 flex-1 truncate font-semibold text-ink-900">
                    {b.name} <span className="font-normal text-ink-600">· batch {b.batchNo}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-700">{formatMilli(b.qtyMilli)} left</span>
                  <Badge tone={b.expired ? "danger" : "warning"}>{b.expired ? `Expired ${dateLabel(b.expiryDate)}` : `Exp ${dateLabel(b.expiryDate)}`}</Badge>
                </Link>
              </li>
            ))}
          </ul>
          {filter !== "expiring" && expiring.length > 6 ? (
            <Link href={href({ status: "expiring" }, shopQuery)} className="mt-1.5 inline-flex min-h-10 items-center text-sm font-semibold text-red-900 underline">
              All {expiring.length} batches
            </Link>
          ) : null}
        </section>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title={summary.rows.length ? "Nothing matches" : "No products yet"} description={summary.rows.length ? "Try another search or filter." : "Add products to your shop, then confirm a purchase bill to bring in stock."} />
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white" aria-label="Stock">
          {rows.map((r) => (
            <li key={r.shopProductId} className="border-b border-[var(--gk-line)] last:border-b-0">
              <Link href={`/shop/accounts/stock/${r.shopProductId}${shopQuery}`} className="flex min-h-14 items-center gap-3 px-3 py-2 hover:bg-teal-50">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-bold text-ink-900">{r.name}</span>
                    {r.status === "OUT_OF_STOCK" ? <Badge tone="danger">OUT</Badge> : r.status === "LOW_STOCK" ? <Badge tone="warning">LOW</Badge> : null}
                    {r.reorder && r.status === "IN_STOCK" ? <Badge tone="info">Reorder</Badge> : null}
                    {r.drift ? <Badge tone="danger">Check count</Badge> : null}
                  </span>
                  <span className="block truncate text-xs text-ink-600">
                    {r.sellableUnit} · cost {formatPaise(r.unitCostPaise)}/unit
                    {r.nearestExpiry ? ` · exp ${dateLabel(r.nearestExpiry)}` : ""}
                    {r.uncostedQtyMilli > 0 ? ` · ${formatMilli(r.uncostedQtyMilli)} without cost` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className={clsx("text-sm font-bold tabular-nums", r.qtyMilli <= 0 ? "text-red-800" : "text-ink-900")}>{formatMilli(r.qtyMilli)}</span>
                  <span className="text-xs tabular-nums text-ink-600">{formatPaise(r.valuePaise)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-ink-600">
        Quantities are in each product&apos;s selling unit. Value is at purchase cost ({summary.method === "FIFO" ? "FIFO" : "weighted average"}) as of {dateLabel(summary.asOf)}.
      </p>
    </div>
  );
}
