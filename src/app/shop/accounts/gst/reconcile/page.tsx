import Link from "next/link";
import clsx from "clsx";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { GstReconButton } from "@/components/accounts/gst-recon-button";
import { Alert } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { RECON_STATUS_LABELS, RECON_STATUSES, type ReconStatus } from "@/lib/accounts/constants";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { formatPaise } from "@/lib/money";
import { reconciliationView } from "@/server/accounts/gst";
import { currentPeriod, loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "Match with GST portal" };
export const dynamic = "force-dynamic";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

const STATUS_STYLE: Record<ReconStatus, { chip: string; row: string }> = {
  MATCHED: { chip: "bg-green-100 text-green-900 ring-green-300", row: "bg-green-50/40" },
  AMOUNT_MISMATCH: { chip: "bg-amber-100 text-amber-900 ring-amber-300", row: "bg-amber-50/60" },
  MISSING_IN_BOOKS: { chip: "bg-red-100 text-red-900 ring-red-300", row: "bg-red-50/60" },
  MISSING_ON_PORTAL: { chip: "bg-violet-100 text-violet-900 ring-violet-300", row: "bg-violet-50/60" },
};

const STATUS_HELP: Record<ReconStatus, { means: string; todo: string }> = {
  MATCHED: {
    means: "The supplier's invoice on the portal matches your bill.",
    todo: "Nothing to do — this input tax credit counts towards your GST estimate.",
  },
  AMOUNT_MISMATCH: {
    means: "The supplier filed this invoice, but with a different amount from your bill.",
    todo: "Check the bill. If your entry is wrong, correct the purchase; if the supplier's is wrong, ask them to correct it in their GSTR-1 (amendment).",
  },
  MISSING_IN_BOOKS: {
    means: "The supplier filed an invoice for you on the portal, but there is no such bill in your books.",
    todo: "If you received the goods, add this bill. If you did not buy this, ask the supplier — they may have used the wrong GSTIN.",
  },
  MISSING_ON_PORTAL: {
    means: "You have this bill in your books, but the supplier has not filed it on the portal (yet).",
    todo: "Ask the supplier to file it in their GSTR-1. Until it appears in your GSTR-2B you cannot claim its input tax credit.",
  },
};

function monthName(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

function shiftMonth(period: string, delta: number): string {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + delta, 1)).toISOString().slice(0, 7);
}

const money = (paise: number | null) => (paise == null ? "—" : formatPaise(Math.round(paise)));

/** docs/inventory-accounting-2026-10, Part 3: suppliers' invoices on the portal vs the bills in the books. */
export default async function GstReconcilePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const period = typeof params.period === "string" && PERIOD.test(params.period) ? params.period : currentPeriod();
  const view = await reconciliationView(shop.id, period);
  const tile = ACCOUNTS_TILES.find((t) => t.key === "reconcile")!;
  const shopParam = shopQuery ? `&${shopQuery.slice(1)}` : "";
  const here = (p: string) => `/shop/accounts/gst/reconcile?period=${p}${shopParam}`;
  const reconImports = view.imports.filter((i) => i.returnType !== "GSTR1");

  const counts = Object.fromEntries(RECON_STATUSES.map((s) => [s, 0])) as Record<ReconStatus, number>;
  for (const item of view.items) counts[item.status] += 1;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="gst" shopQuery={shopQuery} />
      <AccountsHeader
        title={tr(tile.label, lang)}
        subtitle={`${monthName(period)} · your purchase bills vs GSTR-2B / 2A${view.lastRunAt ? ` · last run ${view.lastRunAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}` : ""}`}
        action={<GstReconButton shopId={shop.id} period={period} />}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href={here(shiftMonth(period, -1))} aria-label="Previous month" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 font-semibold hover:bg-kesari-50">
          ←
        </Link>
        <form method="get" className="flex items-center gap-2">
          {shopQuery ? <input type="hidden" name="shop" value={shopQuery.slice(6)} /> : null}
          <label className="sr-only" htmlFor="recon-period">
            Month
          </label>
          <input id="recon-period" type="month" name="period" defaultValue={period} className="min-h-11 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm" />
          <button type="submit" className="min-h-11 rounded-xl bg-kesari-700 px-4 text-sm font-semibold text-white hover:bg-kesari-800">
            Show
          </button>
        </form>
        <Link href={here(shiftMonth(period, 1))} aria-label="Next month" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--gk-line)] bg-white px-3 font-semibold hover:bg-kesari-50">
          →
        </Link>
        <Link href={`/shop/accounts/gst?period=${period}${shopParam}`} className="ml-auto inline-flex min-h-11 items-center text-sm font-semibold text-violet-800 underline">
          ← GST payable
        </Link>
      </div>

      {reconImports.length === 0 ? (
        <div className="mb-3">
          <Alert tone="warning" title={`No GSTR-2B or 2A imported for ${monthName(period)}`}>
            Without the portal data every bill shows as missing on the portal.{" "}
            <Link href={`/shop/accounts/gst?period=${period}${shopParam}#gst-import`} className="font-semibold underline">
              Import GSTR-2B on the GST page
            </Link>{" "}
            (upload the file from gst.gov.in, or pull it through your linked GSTIN), then run the reconciliation again.
          </Alert>
        </div>
      ) : (
        <p className="mb-3 text-sm text-ink-600">
          Portal data: {reconImports.map((i) => `${i.returnType === "GSTR2B" ? "GSTR-2B" : "GSTR-2A"} (${i.invoiceCount} invoices, ${i.createdAt.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })})`).join(" · ")}
        </p>
      )}

      <ul className="mb-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Summary">
        {RECON_STATUSES.map((s) => (
          <li key={s} className={clsx("flex min-h-14 flex-col justify-center rounded-2xl px-3 py-1.5 ring-1", STATUS_STYLE[s].chip)}>
            <span className="text-xs font-semibold">{RECON_STATUS_LABELS[s]}</span>
            <span className="text-2xl font-bold tabular-nums">{counts[s]}</span>
          </li>
        ))}
      </ul>

      {view.items.length ? (
        <div className="mb-3 overflow-x-auto rounded-2xl border border-[var(--gk-line)] bg-white">
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">Invoices of {monthName(period)} and how they matched</caption>
            <thead className="bg-violet-50 text-left text-xs text-ink-700">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Status
                </th>
                <th scope="col" className="px-3 py-2">
                  Supplier GSTIN
                </th>
                <th scope="col" className="px-3 py-2">
                  Invoice no.
                </th>
                <th scope="col" className="px-3 py-2">
                  Date
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Books total
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Portal total
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  Difference
                </th>
                <th scope="col" className="px-3 py-2">
                  Note / action
                </th>
              </tr>
            </thead>
            <tbody>
              {view.items.map((item) => {
                const diff = item.booksTotalPaise != null && item.portalTotalPaise != null ? item.portalTotalPaise - item.booksTotalPaise : null;
                return (
                  <tr key={item.id} className={clsx("border-t border-[var(--gk-line)] align-top", STATUS_STYLE[item.status].row)}>
                    <td className="px-3 py-2">
                      <span className={clsx("inline-block rounded-full px-2 py-0.5 text-xs font-semibold ring-1", STATUS_STYLE[item.status].chip)}>{RECON_STATUS_LABELS[item.status]}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{item.supplierGstin ?? "—"}</td>
                    <td className="px-3 py-2">
                      {item.purchaseInvoiceId ? (
                        <Link href={`/shop/accounts/purchases/${item.purchaseInvoiceId}${shopQuery}`} className="font-semibold text-kesari-700 underline">
                          {item.invoiceNo}
                        </Link>
                      ) : (
                        item.invoiceNo
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{item.invoiceDate ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(item.booksTotalPaise)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(item.portalTotalPaise)}</td>
                    <td className={clsx("px-3 py-2 text-right tabular-nums", diff ? "font-semibold text-amber-900" : "")}>{diff == null ? "—" : `${diff > 0 ? "+" : ""}${money(diff)}`}</td>
                    <td className="px-3 py-2 text-xs text-ink-700">
                      {item.note ? <span className="block">{item.note}</span> : null}
                      {item.status === "MISSING_IN_BOOKS" ? (
                        <Link href={`/shop/accounts/capture${shopQuery}`} className="mt-0.5 inline-flex min-h-10 items-center font-semibold text-kesari-700 underline">
                          Add this bill
                        </Link>
                      ) : null}
                      {item.status === "MISSING_ON_PORTAL" ? <span className="block">Ask the supplier to file it in GSTR-1.</span> : null}
                      {item.status === "AMOUNT_MISMATCH" ? <span className="block">Check your bill, or ask the supplier to amend.</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mb-3 rounded-2xl border border-[var(--gk-line)] bg-white p-4 text-sm text-ink-700">
          No reconciliation for {monthName(period)} yet. Import the month&apos;s GSTR-2B and tap <strong>Run reconciliation</strong>.
        </p>
      )}

      <section aria-labelledby="recon-help" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3">
        <h2 id="recon-help" className="mb-2 text-base font-bold text-ink-900">
          What each result means
        </h2>
        <dl className="grid gap-2 sm:grid-cols-2">
          {RECON_STATUSES.map((s) => (
            <div key={s} className={clsx("rounded-xl p-2.5 ring-1", STATUS_STYLE[s].chip)}>
              <dt className="font-semibold">{RECON_STATUS_LABELS[s]}</dt>
              <dd className="text-sm">
                {STATUS_HELP[s].means} <strong>What to do:</strong> {STATUS_HELP[s].todo}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-ink-600">Input tax credit counts towards your GST estimate only once the bill is matched. These are estimates — verify with your CA before filing.</p>
      </section>
    </div>
  );
}
