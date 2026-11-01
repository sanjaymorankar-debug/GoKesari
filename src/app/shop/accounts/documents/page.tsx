import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { Badge, EmptyState } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { DOCUMENT_TITLE, listDocuments } from "@/server/accounts/documents";
import { loadAccountsPage } from "@/server/accounts/page";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";

export const metadata = { title: "Notes, vouchers & challans" };
export const dynamic = "force-dynamic";

/**
 * Billing v2 (docs/billing §4.1): the shop's credit and debit notes on counter
 * sales, receipt and refund vouchers, delivery challans and estimates.
 */
export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabledForShop("billing_v2", shop))) redirect(`/shop/accounts${shopQuery}`);
  const docs = await listDocuments(shop.id);
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="documents" shopQuery={shopQuery} />
      <AccountsHeader
        title="Notes, vouchers & challans"
        subtitle={`${shop.name} — every document keeps its number for good; cancel instead of editing.`}
        action={
          <Link href={`/shop/accounts/documents/new${shopQuery}`} className="inline-flex min-h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
            + New document
          </Link>
        }
      />
      {docs.length === 0 ? (
        <EmptyState title="No documents yet" description="Issue a credit note on a counter sale, take an advance with a receipt voucher, or send goods on a delivery challan." />
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-[var(--gk-line)] bg-white" aria-label="Documents" data-testid="documents-list">
          {docs.map((d) => (
            <li key={d.id} className="flex min-h-14 items-center gap-3 border-b border-[var(--gk-line)] px-3 py-2 last:border-b-0">
              <span className="w-20 shrink-0 text-sm tabular-nums text-ink-600">{d.docDate}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-ink-900">
                  {d.docNo} · {DOCUMENT_TITLE[d.kind].toLowerCase()}
                </span>
                <span className="block truncate text-xs text-ink-600">
                  {d.buyerName ?? "—"}
                  {d.reason ? ` · ${d.reason}` : ""}
                </span>
              </span>
              <span className={`text-sm font-bold tabular-nums ${d.status === "CANCELLED" ? "text-ink-500 line-through" : "text-ink-900"}`}>{formatPaise(d.totalPaise)}</span>
              {d.status === "CANCELLED" ? <Badge tone="danger">Cancelled</Badge> : <Badge tone="success">Issued</Badge>}
              <a className="text-sm font-semibold text-kesari-800 underline" href={`/api/shops/${shop.id}/accounts/documents/${d.id}/pdf`}>
                PDF
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
