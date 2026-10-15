import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { StockActions } from "@/components/accounts/stock-actions";
import { Alert, Badge, EmptyState } from "@/components/ui";
import { STOCK_MOVEMENT_LABELS } from "@/lib/accounts/constants";
import { formatMilli } from "@/lib/accounts/units";
import { formatPaise } from "@/lib/money";
import { loadAccountsPage } from "@/server/accounts/page";
import { expiringBatches, listingLedger, listListings, stockSummary, type LedgerLine } from "@/server/accounts/stock";

export const metadata = { title: "Stock ledger" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });

function DocRef({ line, shopQuery }: { line: LedgerLine; shopQuery: string }) {
  if (line.sourceType === "PURCHASE_INVOICE" && line.sourceId) {
    return (
      <Link href={`/shop/accounts/purchases/${line.sourceId}${shopQuery}`} className="text-kesari-700 underline">
        {line.docRef ?? "Purchase bill"}
      </Link>
    );
  }
  if (line.sourceType === "SALES_INVOICE" && line.sourceId) {
    return (
      <Link href={`/shop/accounts/sales/${line.sourceId}${shopQuery}`} className="text-kesari-700 underline">
        {line.docRef ?? "Sales invoice"}
      </Link>
    );
  }
  if (line.sourceType === "ORDER") {
    return <span className="text-ink-700">{line.orderId ? `Order ${line.orderId.slice(0, 8)}` : line.docRef ?? "Online order"}</span>;
  }
  if (line.sourceType === "CATALOGUE") return <span className="text-ink-700">Catalogue edit</span>;
  if (line.sourceType === "MIGRATION") return <span className="text-ink-700">Opening (migrated)</span>;
  return <span className="text-ink-700">{line.docRef ?? "Manual"}</span>;
}

/** docs/inventory-accounting-2026-10, Part 1: every movement of one product, with the owner's stock actions. */
export default async function StockLedgerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  if (!UUID.test(id)) notFound();
  const [listing] = await listListings(shop.id, [id]);
  if (!listing) notFound();
  const [ledger, summary, expiring] = await Promise.all([listingLedger(shop.id, id), stockSummary(shop.id), expiringBatches(shop.id, 36_500)]);
  const row = summary.rows.find((r) => r.shopProductId === id);
  const qtyMilli = row?.qtyMilli ?? ledger[0]?.balanceMilli ?? 0;
  const batches = expiring.filter((b) => b.shopProductId === id);

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="stock" shopQuery={shopQuery} />
      <AccountsHeader
        title={listing.name}
        subtitle={`Sold per ${listing.sellableUnit}${listing.hsn ? ` · HSN ${listing.hsn}` : ""}${listing.gstRateBp != null ? ` · GST ${listing.gstRateBp / 100}%` : ""}`}
        action={
          <Link href={`/shop/accounts/stock${shopQuery}`} className="inline-flex min-h-10 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-teal-50">
            ← All stock
          </Link>
        }
      />

      <ul className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <li className="flex min-h-14 flex-col justify-center rounded-xl bg-teal-100 px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-700">In stock</span>
          <span className="flex items-center gap-1.5">
            <span className={clsx("text-xl font-bold tabular-nums", qtyMilli <= 0 ? "text-red-800" : "text-teal-800")}>{formatMilli(qtyMilli)}</span>
            {row?.status === "OUT_OF_STOCK" ? <Badge tone="danger">OUT</Badge> : row?.status === "LOW_STOCK" ? <Badge tone="warning">LOW</Badge> : null}
          </span>
        </li>
        <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">Online / in-shop count</span>
          <span className="text-lg font-bold tabular-nums">
            {listing.onlineStock} / {listing.offlineStock}
          </span>
        </li>
        <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">Cost per unit</span>
          <span className="text-lg font-bold tabular-nums">{row ? formatPaise(row.unitCostPaise) : "—"}</span>
        </li>
        <li className="flex min-h-14 flex-col justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 py-1.5">
          <span className="text-xs font-semibold text-ink-600">Value ({summary.method === "FIFO" ? "FIFO" : "avg cost"})</span>
          <span className="text-lg font-bold tabular-nums">{row ? formatPaise(row.valuePaise) : "—"}</span>
        </li>
      </ul>

      <div className="mb-3">
        <Alert tone="info">Online orders reduce this stock automatically the moment they are placed; cancelled orders put it back.</Alert>
      </div>
      {row?.drift ? (
        <div className="mb-3">
          <Alert tone="warning" title="The listing count differs from the ledger">
            Do a physical count below to set the stock to what is on the shelf.
          </Alert>
        </div>
      ) : null}

      <section className="mb-3 rounded-2xl border border-[var(--gk-line)] bg-white p-3" aria-label="Stock actions">
        <StockActions shopId={shop.id} listingId={id} unit={listing.sellableUnit} qtyMilli={qtyMilli} trackBatches={row?.trackBatches ?? false} batches={batches.map((b) => ({ batchId: b.batchId, batchNo: b.batchNo, expiryDate: b.expiryDate, qtyMilli: b.qtyMilli }))} />
        {batches.length ? (
          <ul className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label="Batches in stock">
            {batches.map((b) => (
              <li key={b.batchId}>
                <Badge tone={b.expired ? "danger" : "warning"}>
                  {b.batchNo}: {formatMilli(b.qtyMilli)} · {b.expired ? "expired" : "exp"} {dateLabel(b.expiryDate)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="ledger-title">
        <h2 id="ledger-title" className="mb-2 text-base font-bold text-ink-900">
          Movements (newest first)
        </h2>
        {ledger.length === 0 ? (
          <EmptyState title="No movements yet" description="Confirm a purchase bill or set an opening count to start this product's ledger." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">Stock movements of {listing.name}</caption>
              <thead>
                <tr className="border-b border-[var(--gk-line)] text-left text-xs text-ink-600">
                  <th scope="col" className="px-3 py-2">Date</th>
                  <th scope="col" className="px-3 py-2">Type</th>
                  <th scope="col" className="px-3 py-2 text-right">Qty</th>
                  <th scope="col" className="px-3 py-2 text-right">Balance</th>
                  <th scope="col" className="px-3 py-2 text-right">Cost/unit</th>
                  <th scope="col" className="px-3 py-2">Document</th>
                  <th scope="col" className="px-3 py-2">Note</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {ledger.map((l) => (
                  <tr key={l.id} className="border-b border-[var(--gk-line)] last:border-b-0">
                    <td className="whitespace-nowrap px-3 py-2 text-ink-700">{dateLabel(l.entryDate)}</td>
                    <td className="px-3 py-2">
                      <span className="font-semibold text-ink-900">{STOCK_MOVEMENT_LABELS[l.movementType] ?? l.movementType}</span>
                      <span className="block text-xs text-ink-600">
                        {l.channel === "ONLINE" ? "Online" : "In-shop"}
                        {l.batchNo ? ` · batch ${l.batchNo}` : ""}
                      </span>
                    </td>
                    <td className={clsx("px-3 py-2 text-right font-semibold", l.qtyMilli > 0 ? "text-green-800" : "text-red-800")}>
                      {l.qtyMilli > 0 ? "+" : "−"}
                      {formatMilli(Math.abs(l.qtyMilli))}
                    </td>
                    <td className="px-3 py-2 text-right">{formatMilli(l.balanceMilli)}</td>
                    <td className="px-3 py-2 text-right">{l.unitCostPaise != null ? formatPaise(l.unitCostPaise) : "—"}</td>
                    <td className="px-3 py-2">
                      <DocRef line={l} shopQuery={shopQuery} />
                    </td>
                    <td className="max-w-56 px-3 py-2 text-xs text-ink-600">{l.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ledger.length >= 200 ? <p className="mt-1 text-xs text-ink-600">Showing the latest 200 movements. The full history is in Reports.</p> : null}
      </section>
    </div>
  );
}
