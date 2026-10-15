import Link from "next/link";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { SalesInvoiceForm } from "@/components/accounts/sales-invoice-form";
import { Alert } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { stateOfGstin } from "@/lib/accounts/gst-math";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { gstState } from "@/lib/gst-states";
import { todayIst } from "@/server/accounts/books";
import { loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "New sales invoice" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10, Part 2: issue a GST sales invoice. */
export default async function NewSalesInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { shop, lang, shopQuery } = await loadAccountsPage(await searchParams);
  const sellerState = stateOfGstin(shop.gstin) ?? gstState(shop.state)?.code ?? null;
  const tile = ACCOUNTS_TILES.find((t) => t.key === "sales")!;
  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="sales" shopQuery={shopQuery} />
      <AccountsHeader
        title={tr(tile.label, lang)}
        subtitle={`${shop.name}${shop.gstin ? ` · GSTIN ${shop.gstin}` : ""}`}
        action={
          <Link href={`/shop/accounts/sales${shopQuery}`} className="inline-flex min-h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50">
            ← All invoices
          </Link>
        }
      />
      {sellerState ? null : (
        <div className="mb-3">
          <Alert tone="warning" title="Your shop's GSTIN or state is missing">
            GST invoices need the state you supply from. Add your GSTIN in your shop profile first.
          </Alert>
        </div>
      )}
      <SalesInvoiceForm shopId={shop.id} shopQuery={shopQuery} sellerState={sellerState} today={todayIst()} />
    </div>
  );
}
