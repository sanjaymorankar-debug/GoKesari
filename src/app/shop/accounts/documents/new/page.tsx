import { redirect } from "next/navigation";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { DocumentForm } from "@/components/billing/document-form";
import { listDocuments } from "@/server/accounts/documents";
import { loadAccountsPage } from "@/server/accounts/page";
import { listSalesInvoices } from "@/server/accounts/sales";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "New document" };
export const dynamic = "force-dynamic";

/** Billing v2 (docs/billing §4.1): issue a credit / debit note, voucher, challan or estimate. */
export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  if (!(await isFeatureEnabled("billing_v2"))) redirect(`/shop/accounts${shopQuery}`);
  const [sales, receipts] = await Promise.all([listSalesInvoices(shop.id), listDocuments(shop.id, { kind: "RECEIPT_VOUCHER" })]);
  return (
    <div className="mx-auto w-full max-w-4xl">
      <AccountsNav lang={lang} current="documents" shopQuery={shopQuery} />
      <AccountsHeader title="New document" subtitle={shop.name} />
      <DocumentForm
        shopId={shop.id}
        backHref={`/shop/accounts/documents${shopQuery}`}
        invoices={sales.filter((s) => s.status === "ISSUED").map((s) => ({ id: s.id, label: `${s.invoiceNo} · ${s.buyerName ?? "Cash customer"} · ₹${(s.totalPaise / 100).toFixed(2)}` }))}
        receipts={receipts.filter((r) => r.status === "ISSUED").map((r) => ({ id: r.id, label: `${r.docNo} · ${r.buyerName ?? "—"} · ₹${(r.totalPaise / 100).toFixed(2)}` }))}
      />
    </div>
  );
}
